'use strict';

/**
 * MediaMTX external authentication endpoint (authMethod: http).
 *
 * MediaMTX v1.20.1 POSTs this JSON payload for every action
 * (publish/read/playback/api/metrics/pprof):
 *   { ip, user, password, token, action, path, protocol, id, query, userAgent }
 * - `path` is the mediamtx path WITHOUT leading slash (e.g. "live/abc123")
 * - `token` is already extracted by mediamtx from ?token= (or the password);
 *   `query` is the RAW query string, parsed here only as a fallback
 * - any 2xx response allows the action, anything else denies it (fail-closed)
 *
 * Decision matrix:
 * - publish: only for rtmp/rtmps publishers on ^/?live/<broadcastId>$ with a
 *   valid stream key (sha256, timing-safe compare against the entry looked up
 *   by broadcastId FIRST; a fixed dummy hash keeps the timing uniform when
 *   the broadcastId has no entry). Rate limited per IP (10 failed attempts /
 *   60s). Note: mediamtx v1.20.1 reports protocol "rtmp" for BOTH the plain
 *   and the TLS listener (internal/auth/request.go has no "rtmps" constant);
 *   "rtmps" is allowed defensively for future versions, "rtsp" publish was
 *   removed (public ingest is RTMPS-only, the internal pull is plain rtmp).
 * - read: allowed ONLY for the adapter itself (its own RTMP pull of the
 *   already-authenticated publisher stream). Everyone else gets 401.
 * - api/metrics/pprof: allowed ONLY for the adapter itself (paths list).
 * - playback and everything else: denied (v1 has no direct mediamtx playback).
 *
 * Logging discipline: only ip, path, action and the decision are ever logged.
 * Tokens, query strings, passwords and headers are never logged.
 */

const crypto = require('node:crypto');

const PATH_RE = /^\/?live\/([A-Za-z0-9_-]{1,128})$/;
// mediamtx v1.20.1 sends "rtmp" for plain RTMP AND RTMPS publishers (no
// separate "rtmps" protocol constant exists); "rtmps" stays allowed
// defensively. "rtsp" publish was dropped: public ingest is RTMPS-only.
const PUBLISH_PROTOCOLS = new Set(['rtmp', 'rtmps']);
const READ_PROTOCOLS = new Set(['rtmp', 'rtsp']);
const MAX_TOKEN_LENGTH = 4096;
const MAX_BODY_BYTES = 128 * 1024;
const RATE_LIMITER_MAX_ENTRIES = 10000;

/** In-memory fixed-window rate limiter for failed publish attempts. */
class RateLimiter {
    /**
     * @param {object} options
     * @param {number} options.windowMs
     * @param {number} options.maxAttempts max failed attempts per window
     * @param {number} [options.maxEntries] hard cap on tracked keys; when the
     *   map is full, entries with the oldest reset windows are evicted first
     *   (sorted sweep over the Map) so key-spoofing cannot grow memory
     *   without bound. Defaults to RATE_LIMITER_MAX_ENTRIES.
     */
    constructor({ windowMs = 60000, maxAttempts = 10, maxEntries = RATE_LIMITER_MAX_ENTRIES } = {}) {
        this.windowMs = windowMs;
        this.maxAttempts = maxAttempts;
        this.maxEntries = maxEntries;
        this.entries = new Map();
    }

    /** True when the key has exceeded the failed-attempt budget. */
    isBlocked(key, now = Date.now()) {
        const entry = this.entries.get(key);
        if (!entry) return false;
        if (now >= entry.resetAt) {
            this.entries.delete(key);
            return false;
        }
        return entry.count >= this.maxAttempts;
    }

    registerFailure(key, now = Date.now()) {
        const entry = this.entries.get(key);
        if (!entry || now >= entry.resetAt) {
            if (this.entries.size >= this.maxEntries) this.evictOldest();
            this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
            return;
        }
        entry.count += 1;
    }

    reset(key) {
        this.entries.delete(key);
    }

    /** Drop expired entries to keep the map bounded. */
    sweep(now = Date.now()) {
        for (const [key, entry] of this.entries) {
            if (now >= entry.resetAt) this.entries.delete(key);
        }
    }

    /**
     * Make room for one new entry: delete entries with the smallest resetAt
     * (oldest windows) first. Map insertion order approximates window age
     * because entries are only re-inserted when their window resets.
     */
    evictOldest() {
        const sorted = [...this.entries].sort(([, a], [, b]) => a.resetAt - b.resetAt);
        const toEvict = this.entries.size - this.maxEntries + 1;
        for (let i = 0; i < toEvict && i < sorted.length; i += 1) {
            this.entries.delete(sorted[i][0]);
        }
    }
}

/**
 * Extract the presented token. MediaMTX v1.20.1 puts the pre-extracted token
 * in `body.token`; parse the raw `query` string only as a fallback. An object
 * shaped `query` (older mediamtx behavior) is tolerated too.
 */
function extractToken(body) {
    if (typeof body.token === 'string' && body.token.length > 0) return body.token;
    const query = body.query;
    if (typeof query === 'string' && query.length > 0 && query.length <= MAX_TOKEN_LENGTH * 8) {
        const params = new URLSearchParams(query);
        const token = params.get('token');
        if (token) return token;
        return '';
    }
    if (query && typeof query === 'object' && typeof query.token === 'string') return query.token;
    return '';
}

/**
 * Normalize IPv4-mapped IPv6 addresses ('::ffff:127.0.0.1') to plain IPv4 so
 * comparisons against the interface allow-list cannot be bypassed (or broken)
 * by the mapped notation.
 */
function normalizeIp(ip) {
    if (typeof ip !== 'string') return ip;
    if (ip.startsWith('::ffff:')) return ip.slice('::ffff:'.length);
    return ip;
}

/** Fixed 32-byte dummy comparison target (all zeros, never a sha256 output). */
const DUMMY_HASH_BUFFER = Buffer.alloc(32);

/**
 * Timing-safe stream key check with uniform timing: the sha256 hash is
 * ALWAYS computed (even when the broadcastId has no entry), then a single
 * constant-time comparison runs against the entry's hash when present and
 * against the fixed dummy buffer otherwise. This keeps the response time
 * independent of whether a broadcastId exists. The entry is looked up by
 * broadcastId FIRST (no iteration over streams); both buffers are exactly
 * 32 bytes (sha256 hex is validated at load time).
 */
function isValidStreamKey(token, entry) {
    const tokenValid = typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
    const presented = crypto.createHash('sha256').update(tokenValid ? token : '', 'utf8').digest(); // 32 bytes
    let expected = DUMMY_HASH_BUFFER;
    if (entry && typeof entry.keyHash === 'string') {
        const candidate = Buffer.from(entry.keyHash, 'hex'); // 32 bytes (validated in keys.js)
        if (candidate.length === presented.length) expected = candidate;
    }
    const matches = crypto.timingSafeEqual(presented, expected);
    return tokenValid && matches;
}

/**
 * Pure decision function for one authentication request.
 *
 * @param {object} body mediamtx auth payload
 * @param {object} ctx
 * @param {object} ctx.keyStore KeyStore instance (lookup by broadcastId)
 * @param {Set<string>} ctx.localIps the adapter's own interface addresses
 * @param {RateLimiter} ctx.rateLimiter
 * @param {number} [ctx.now]
 * @returns {{status: number, broadcastId: string|null, reason: string, allowed: boolean}}
 */
function evaluateAuth(body, ctx) {
    const now = ctx.now !== undefined ? ctx.now : Date.now();

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { status: 401, broadcastId: null, reason: 'invalid body', allowed: false };
    }

    const action = typeof body.action === 'string' ? body.action : '';
    const ip = typeof body.ip === 'string' && body.ip.length > 0 && body.ip.length <= 64 ? body.ip : 'unknown';
    const normalizedIp = normalizeIp(ip); // '::ffff:127.0.0.1' -> '127.0.0.1'
    const path = typeof body.path === 'string' ? body.path : '';
    const protocol = typeof body.protocol === 'string' ? body.protocol : '';

    // Control API access (paths list): only the adapter itself.
    if (action === 'api' || action === 'metrics' || action === 'pprof') {
        if (ctx.localIps.has(normalizedIp)) {
            return { status: 200, broadcastId: null, reason: 'local control access', allowed: true };
        }
        return { status: 401, broadcastId: null, reason: 'control access denied', allowed: false };
    }

    // The adapter's own internal RTMP pull of an authenticated publisher.
    if (action === 'read') {
        if (ctx.localIps.has(normalizedIp) && READ_PROTOCOLS.has(protocol) && PATH_RE.test(path)) {
            return { status: 200, broadcastId: null, reason: 'local read', allowed: true };
        }
        return { status: 401, broadcastId: null, reason: 'read denied', allowed: false };
    }

    // v1: no playback through mediamtx at all.
    if (action === 'playback') {
        return { status: 401, broadcastId: null, reason: 'playback denied', allowed: false };
    }

    if (action !== 'publish') {
        return { status: 401, broadcastId: null, reason: 'unsupported action', allowed: false };
    }

    // Publish: rate limit first (cheap), then path, then key.
    if (ctx.rateLimiter.isBlocked(normalizedIp, now)) {
        return { status: 429, broadcastId: null, reason: 'rate limited', allowed: false };
    }

    const match = PATH_RE.exec(path);
    if (!match) {
        ctx.rateLimiter.registerFailure(normalizedIp, now);
        return { status: 401, broadcastId: null, reason: 'invalid path', allowed: false };
    }
    const broadcastId = match[1];

    if (!PUBLISH_PROTOCOLS.has(protocol)) {
        ctx.rateLimiter.registerFailure(normalizedIp, now);
        return { status: 401, broadcastId, reason: 'protocol not allowed for publish', allowed: false };
    }

    const token = extractToken(body);
    const entry = ctx.keyStore.get(broadcastId);
    if (!isValidStreamKey(token, entry)) {
        ctx.rateLimiter.registerFailure(normalizedIp, now);
        return { status: 401, broadcastId, reason: 'invalid stream key', allowed: false };
    }

    ctx.rateLimiter.reset(normalizedIp);
    return { status: 200, broadcastId, reason: 'authorized', allowed: true };
}

/**
 * HTTP handler for POST /auth/publish. Body already parsed as JSON object.
 * Returns {status, body} — never throws; logs only ip/path/action/decision.
 */
function createAuthHandler({ keyStore, localIps, rateLimiter, log }) {
    let lastSweep = Date.now();
    return function handleAuth(body, requestMeta = {}) {
        const decision = evaluateAuth(body, { keyStore, localIps, rateLimiter });

        const now = Date.now();
        if (now - lastSweep > 60000) {
            rateLimiter.sweep(now);
            lastSweep = now;
        }

        const responseBody =
            decision.status === 200 ? {} : { error: decision.status === 429 ? 'too many requests' : 'unauthorized' };

        const logFields = {
            ip: typeof body?.ip === 'string' ? body.ip : undefined,
            path: typeof body?.path === 'string' ? body.path : undefined,
            action: typeof body?.action === 'string' ? body.action : undefined,
            decision: decision.status === 200 ? 'allow' : 'deny',
        };
        if (requestMeta.requestId) logFields.requestId = requestMeta.requestId;

        if (decision.status === 200) {
            log.info('auth decision', logFields);
        } else if (decision.status === 429) {
            log.warn('auth rate limited', logFields);
        } else {
            log.warn('auth decision', logFields);
        }

        return { status: decision.status, body: responseBody };
    };
}

module.exports = {
    RateLimiter,
    evaluateAuth,
    extractToken,
    isValidStreamKey,
    normalizeIp,
    createAuthHandler,
    PATH_RE,
    MAX_BODY_BYTES,
    RATE_LIMITER_MAX_ENTRIES,
};
