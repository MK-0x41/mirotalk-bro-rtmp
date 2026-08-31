'use strict';

/**
 * Unit tests for auth.js pure decision + rate-limit seams.
 * No HTTP server, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { RateLimiter, evaluateAuth, extractToken, isValidStreamKey, PATH_RE, normalizeIp } = require('../src/auth');

const STREAM_KEY = 'fake-stream-key-for-tests-only';
const OTHER_KEY = 'other-fake-stream-key-for-tests';
const KEY_HASH = crypto.createHash('sha256').update(STREAM_KEY, 'utf8').digest('hex');
const OTHER_HASH = crypto.createHash('sha256').update(OTHER_KEY, 'utf8').digest('hex');

function keyStore(streams) {
    return {
        get(broadcastId) {
            return Object.prototype.hasOwnProperty.call(streams, broadcastId) ? streams[broadcastId] : null;
        },
    };
}

function ctx(overrides = {}) {
    return {
        keyStore: keyStore({ room1: { keyHash: KEY_HASH }, room2: { keyHash: OTHER_HASH } }),
        localIps: new Set(['127.0.0.1', '::1', '10.0.0.8']),
        rateLimiter: new RateLimiter({ windowMs: 60_000, maxAttempts: 3 }),
        now: 1_000_000,
        ...overrides,
    };
}

function publishBody(overrides = {}) {
    return {
        ip: '203.0.113.10',
        action: 'publish',
        path: 'live/room1',
        protocol: 'rtmp',
        token: STREAM_KEY,
        query: '',
        ...overrides,
    };
}

describe('PATH_RE', () => {
    it('accepts live/<id> with and without a leading slash', () => {
        assert.match('live/abc', PATH_RE);
        assert.match('/live/abc', PATH_RE);
        assert.match('live/A-Za0_9', PATH_RE);
        assert.equal(PATH_RE.exec('live/abc')[1], 'abc');
        assert.equal(PATH_RE.exec('/live/abc')[1], 'abc');
    });

    it('rejects traversal, missing slash, overlong ids and invalid chars', () => {
        assert.equal(PATH_RE.test('/live/../escape'), false);
        assert.equal(PATH_RE.test('live/../escape'), false);
        assert.equal(PATH_RE.test('liveabc'), false);
        assert.equal(PATH_RE.test('abc'), false);
        assert.equal(PATH_RE.test('live/'), false);
        assert.equal(PATH_RE.test('vod/room1'), false);
        assert.equal(PATH_RE.test(`live/${'x'.repeat(129)}`), false);
        assert.equal(PATH_RE.test('live/room.1'), false);
        assert.equal(PATH_RE.test('live/room 1'), false);
        assert.equal(PATH_RE.test('live/room/extra'), false);
    });
});

describe('extractToken', () => {
    it('prefers the pre-extracted token field (mediamtx v1.20.1)', () => {
        assert.equal(extractToken({ token: 'from-token', query: 'token=from-query' }), 'from-token');
    });

    it('falls back to a raw query string', () => {
        assert.equal(extractToken({ token: '', query: 'foo=1&token=from-query' }), 'from-query');
        assert.equal(extractToken({ query: 'token=only-query' }), 'only-query');
    });

    it('tolerates an object-shaped query (older mediamtx)', () => {
        assert.equal(extractToken({ query: { token: 'object-token' } }), 'object-token');
    });

    it('returns empty when no token is present', () => {
        assert.equal(extractToken({}), '');
        assert.equal(extractToken({ token: '', query: '' }), '');
        assert.equal(extractToken({ query: 'foo=bar' }), '');
        assert.equal(extractToken({ query: { other: 'x' } }), '');
    });
});

describe('isValidStreamKey', () => {
    it('accepts the matching utf8 token against a sha256 hex entry', () => {
        assert.equal(isValidStreamKey(STREAM_KEY, { keyHash: KEY_HASH }), true);
    });

    it('rejects a wrong token, empty token, missing entry, or overlong token', () => {
        assert.equal(isValidStreamKey(OTHER_KEY, { keyHash: KEY_HASH }), false);
        assert.equal(isValidStreamKey('', { keyHash: KEY_HASH }), false);
        assert.equal(isValidStreamKey(STREAM_KEY, null), false);
        assert.equal(isValidStreamKey('x'.repeat(4097), { keyHash: KEY_HASH }), false);
    });
});

describe('evaluateAuth publish', () => {
    it('allows a valid token + path (no leading slash)', () => {
        const decision = evaluateAuth(publishBody(), ctx());
        assert.equal(decision.status, 200);
        assert.equal(decision.allowed, true);
        assert.equal(decision.broadcastId, 'room1');
        assert.equal(decision.reason, 'authorized');
    });

    it('allows rtmp and rtmps publish and denies rtsp publish', () => {
        const rtmp = evaluateAuth(publishBody({ path: '/live/room1', protocol: 'rtmp' }), ctx());
        assert.equal(rtmp.status, 200);
        assert.equal(rtmp.allowed, true);
        assert.equal(rtmp.broadcastId, 'room1');

        const rtmps = evaluateAuth(publishBody({ path: '/live/room1', protocol: 'rtmps' }), ctx());
        assert.equal(rtmps.status, 200);
        assert.equal(rtmps.allowed, true);
        assert.equal(rtmps.broadcastId, 'room1');

        const rtsp = evaluateAuth(publishBody({ path: '/live/room1', protocol: 'rtsp' }), ctx());
        assert.equal(rtsp.status, 401);
        assert.equal(rtsp.allowed, false);
        assert.equal(rtsp.reason, 'protocol not allowed for publish');
        assert.equal(rtsp.broadcastId, 'room1');
    });

    it('denies a wrong token on the same path', () => {
        const decision = evaluateAuth(publishBody({ token: OTHER_KEY }), ctx());
        assert.equal(decision.status, 401);
        assert.equal(decision.allowed, false);
        assert.equal(decision.broadcastId, 'room1');
        assert.equal(decision.reason, 'invalid stream key');
    });

    it('denies a token that is valid for a different broadcastId', () => {
        const decision = evaluateAuth(publishBody({ path: 'live/room1', token: OTHER_KEY }), ctx());
        assert.equal(decision.status, 401);
        assert.equal(decision.reason, 'invalid stream key');

        const otherPath = evaluateAuth(publishBody({ path: 'live/room2', token: STREAM_KEY }), ctx());
        assert.equal(otherPath.status, 401);
        assert.equal(otherPath.broadcastId, 'room2');
    });

    it('denies an empty token', () => {
        const decision = evaluateAuth(publishBody({ token: '', query: '' }), ctx());
        assert.equal(decision.status, 401);
        assert.equal(decision.reason, 'invalid stream key');
    });

    it('accepts a token from the raw query string when body.token is empty', () => {
        const decision = evaluateAuth(publishBody({ token: '', query: `token=${STREAM_KEY}` }), ctx());
        assert.equal(decision.status, 200);
    });

    it('accepts a token from an object-shaped query', () => {
        const decision = evaluateAuth(publishBody({ token: '', query: { token: STREAM_KEY } }), ctx());
        assert.equal(decision.status, 200);
    });

    it('denies path traversal, no-slash variants, overlong ids and invalid chars', () => {
        for (const path of ['/live/../escape', 'liveabc', 'live/', `live/${'x'.repeat(129)}`, 'live/room.1']) {
            const decision = evaluateAuth(publishBody({ path }), ctx());
            assert.equal(decision.status, 401, path);
            assert.equal(decision.reason, 'invalid path', path);
            assert.equal(decision.broadcastId, null, path);
        }
    });

    it('denies a non-rtmp/rtsp publish protocol', () => {
        const decision = evaluateAuth(publishBody({ protocol: 'webrtc' }), ctx());
        assert.equal(decision.status, 401);
        assert.equal(decision.reason, 'protocol not allowed for publish');
        assert.equal(decision.broadcastId, 'room1');
    });
});

describe('evaluateAuth action policy', () => {
    it('allows api/metrics/pprof only from the adapter\'s own IPs', () => {
        for (const action of ['api', 'metrics', 'pprof']) {
            const allowed = evaluateAuth({ action, ip: '10.0.0.8', path: '', protocol: '' }, ctx());
            assert.equal(allowed.status, 200, action);
            assert.equal(allowed.reason, 'local control access', action);

            const denied = evaluateAuth({ action, ip: '203.0.113.10', path: '', protocol: '' }, ctx());
            assert.equal(denied.status, 401, action);
            assert.equal(denied.reason, 'control access denied', action);
        }
    });

    it('allows read only from a local IP, rtmp/rtsp, and a live path', () => {
        const allowed = evaluateAuth(
            { action: 'read', ip: '127.0.0.1', path: 'live/room1', protocol: 'rtmp' },
            ctx()
        );
        assert.equal(allowed.status, 200);
        assert.equal(allowed.reason, 'local read');

        const foreign = evaluateAuth(
            { action: 'read', ip: '203.0.113.10', path: 'live/room1', protocol: 'rtmp' },
            ctx()
        );
        assert.equal(foreign.status, 401);
        assert.equal(foreign.reason, 'read denied');

        const badPath = evaluateAuth(
            { action: 'read', ip: '127.0.0.1', path: 'live/../escape', protocol: 'rtmp' },
            ctx()
        );
        assert.equal(badPath.status, 401);

        const badProto = evaluateAuth(
            { action: 'read', ip: '127.0.0.1', path: 'live/room1', protocol: 'hls' },
            ctx()
        );
        assert.equal(badProto.status, 401);
    });

    it('denies playback and unknown actions', () => {
        assert.equal(evaluateAuth({ action: 'playback', ip: '127.0.0.1' }, ctx()).status, 401);
        assert.equal(evaluateAuth({ action: 'playback', ip: '127.0.0.1' }, ctx()).reason, 'playback denied');
        assert.equal(evaluateAuth({ action: 'unknown', ip: '10.0.0.8' }, ctx()).reason, 'unsupported action');
        assert.equal(evaluateAuth({ action: '', ip: '10.0.0.8' }, ctx()).reason, 'unsupported action');
    });

    it('denies a non-object body', () => {
        assert.equal(evaluateAuth(null, ctx()).status, 401);
        assert.equal(evaluateAuth([], ctx()).status, 401);
        assert.equal(evaluateAuth('x', ctx()).reason, 'invalid body');
    });
});

describe('RateLimiter + evaluateAuth rate limit', () => {
    it('blocks after max failed attempts and reports 429', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxAttempts: 3 });
        const authCtx = ctx({ rateLimiter: limiter, now: 5000 });

        for (let i = 0; i < 3; i += 1) {
            const denied = evaluateAuth(publishBody({ token: 'wrong' }), authCtx);
            assert.equal(denied.status, 401);
        }
        const blocked = evaluateAuth(publishBody({ token: 'wrong' }), authCtx);
        assert.equal(blocked.status, 429);
        assert.equal(blocked.reason, 'rate limited');
        assert.equal(blocked.allowed, false);

        // A later valid key is still blocked until the window expires.
        const stillBlocked = evaluateAuth(publishBody(), authCtx);
        assert.equal(stillBlocked.status, 429);
    });

    it('resets the window on a successful publish', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxAttempts: 3 });
        const authCtx = ctx({ rateLimiter: limiter, now: 5000 });

        evaluateAuth(publishBody({ token: 'wrong' }), authCtx);
        evaluateAuth(publishBody({ token: 'wrong' }), authCtx);
        const ok = evaluateAuth(publishBody(), authCtx);
        assert.equal(ok.status, 200);

        const after = evaluateAuth(publishBody({ token: 'wrong' }), authCtx);
        assert.equal(after.status, 401);
        assert.equal(limiter.isBlocked('203.0.113.10', 5000), false);
    });

    it('expires the window using the injectable now clock (no real wait)', () => {
        const limiter = new RateLimiter({ windowMs: 100, maxAttempts: 2 });
        limiter.registerFailure('203.0.113.10', 1000);
        limiter.registerFailure('203.0.113.10', 1000);
        assert.equal(limiter.isBlocked('203.0.113.10', 1099), true);
        assert.equal(limiter.isBlocked('203.0.113.10', 1100), false);

        const authCtx = ctx({ rateLimiter: limiter, now: 1100 });
        const decision = evaluateAuth(publishBody(), authCtx);
        assert.equal(decision.status, 200);
    });

    it('sweep drops expired entries', () => {
        const limiter = new RateLimiter({ windowMs: 50, maxAttempts: 1 });
        limiter.registerFailure('a', 1000);
        limiter.registerFailure('b', 1040);
        limiter.sweep(1050);
        assert.equal(limiter.entries.has('a'), false);
        assert.equal(limiter.entries.has('b'), true);
    });

    it('evicts the oldest window when maxEntries is reached', () => {
        const limiter = new RateLimiter({ windowMs: 1000, maxAttempts: 10, maxEntries: 2 });
        limiter.registerFailure('ip-a', 1000);
        limiter.registerFailure('ip-b', 1500);
        assert.equal(limiter.entries.size, 2);

        limiter.registerFailure('ip-c', 1600);
        assert.equal(limiter.entries.has('ip-a'), false);
        assert.equal(limiter.entries.has('ip-b'), true);
        assert.equal(limiter.entries.has('ip-c'), true);
        assert.equal(limiter.entries.size, 2);
    });
});

describe('normalizeIp', () => {
    it('strips an IPv4-mapped IPv6 prefix and passes other values through', () => {
        assert.equal(normalizeIp('::ffff:192.0.2.1'), '192.0.2.1');
        assert.equal(normalizeIp('192.0.2.1'), '192.0.2.1');
        assert.equal(normalizeIp('::1'), '::1');
        assert.equal(normalizeIp('unknown'), 'unknown');
        assert.equal(normalizeIp(null), null);
    });

    it('treats a mapped IPv6 local address as a local control IP', () => {
        const decision = evaluateAuth({ action: 'api', ip: '::ffff:127.0.0.1', path: '', protocol: '' }, ctx());
        assert.equal(decision.status, 200);
        assert.equal(decision.reason, 'local control access');
    });
});
