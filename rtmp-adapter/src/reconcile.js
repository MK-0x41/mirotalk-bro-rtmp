'use strict';

/**
 * Reconciliation loop: keeps FFmpeg ingests in sync with mediamtx paths.
 *
 * Every cycle (RECONCILE_INTERVAL_MS, default 2s) the adapter lists
 *   GET {MEDIAMTX_API_BASE}/v3/paths/list   -> { itemCount, items: [...] }
 * and treats a path as an active ingest source when
 *   - its name matches live/<broadcastId>
 *   - it is ready (item.ready === true, OR item.available === true since
 *     "ready" is deprecated but still present in v1.20.1), and
 *   - its source.type is a live publisher session (rtmpConn/rtmpsConn/
 *     rtspSession/rtspsSession/...), i.e. NOT a pull source.
 *
 * New path  -> POST /api/v1/external-ingest/start on BRO (Bearer secret,
 *              idempotent by contract) -> spawn FFmpeg.
 * Gone path -> SIGTERM FFmpeg (SIGKILL after 5s) -> POST .../stop.
 * FFmpeg crash -> restart with backoff 1s/2s/5s/10s/30s (cap), backoff reset
 *              after 5 minutes of stable runtime. The restart always re-POSTs
 *              start and re-spawns with the returned args, so the state
 *              mirrors the ports/SSRCs FFmpeg actually uses; a changed
 *              transport is logged.
 * BRO start failure -> retry with the same backoff ladder, then a 5 minute
 *              cooldown before the next burst.
 * BRO restart   -> every STATUS_CHECK_INTERVAL_MS (30s) per RUNNING ingest a
 *              GET /api/v1/external-ingest/status verifies BRO still lists
 *              the broadcastId. A positive missing signal tears the ingest
 *              down (ffmpeg TERM/KILL) and clears the state, so the normal
 *              start path re-runs with fresh ports/SSRCs. Transient status
 *              failures only skip the cycle (debug log) — never tear down.
 * Ingest cap   -> MAX_CONCURRENT_INGESTS (config.js, default 4): new ingests
 *              are deferred while the cap is reached (error logged at most
 *              once per path per cooldown); existing ingests are unaffected.
 *
 * A failed paths listing never tears anything down (transient mediamtx
 * outages must not kill running ingests); only a successful listing that no
 * longer contains a path removes its state.
 */

const { buildFfmpegArgs, spawnFfmpegProcess, stderrIndicatesMissingAudio } = require('./ffmpeg');

const PUBLISHER_SOURCE_TYPES = new Set([
    'rtmpConn',
    'rtmpsConn',
    'rtspSession',
    'rtspsSession',
    'srtConn',
    'webRTCSession',
    'moqSession',
]);

const LIVE_PATH_RE = /^live\/([A-Za-z0-9_-]{1,128})$/;
// ssrc is capped at 0x7fffffff: ffmpeg's -ssrc rejects anything above the
// signed 31-bit range and BRO generates ssrcs with randomInt(1, 0x7fffffff).
const INGEST_FIELD_RANGES = [
    ['port', 1, 65535],
    ['payloadType', 0, 127],
    ['ssrc', 1, 0x7fffffff],
];
const BACKOFF_LADDER_MS = [1000, 2000, 5000, 10000, 30000];
const START_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const FFMPEG_KILL_GRACE_MS = 5000;
const STABLE_RUNTIME_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 5000;
// BRO-restart re-attach: at most one status check per ingest per interval.
const STATUS_CHECK_INTERVAL_MS = 30 * 1000;
// Cap warning throttle: error-level at most once per path per cooldown.
const CAP_WARN_COOLDOWN_MS = 60 * 1000;

function backoffDelay(attempts) {
    return BACKOFF_LADDER_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_LADDER_MS.length - 1)];
}

/** Extract active broadcastIds from a /v3/paths/list response (pure). */
function extractActiveBroadcastIds(listResponse) {
    const active = new Map();
    const items = listResponse && Array.isArray(listResponse.items) ? listResponse.items : [];
    for (const item of items) {
        if (!item || typeof item !== 'object' || typeof item.name !== 'string') continue;
        const match = LIVE_PATH_RE.exec(item.name);
        if (!match) continue;
        const sourceType = item.source && typeof item.source === 'object' ? item.source.type : null;
        const ready = item.ready === true || item.available === true;
        if (ready && PUBLISHER_SOURCE_TYPES.has(sourceType)) {
            active.set(match[1], { sourceType });
        }
    }
    return active;
}

/** Validate the BRO start response shape; throws on contract violations. */
function validateIngestResponse(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('BRO start response is not an object');
    }
    if (typeof payload.broadcastId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.broadcastId)) {
        throw new Error('BRO start response has no valid broadcastId');
    }
    for (const kind of ['video', 'audio']) {
        const track = payload[kind];
        if (!track || typeof track !== 'object') throw new Error(`BRO start response misses track "${kind}"`);
        for (const [field, min, max] of INGEST_FIELD_RANGES) {
            const value = track[field];
            if (!Number.isInteger(value) || value < min || value > max) {
                throw new Error(`BRO start response ${kind}.${field} must be an integer between ${min} and ${max}`);
            }
        }
        if (track.rtcpPort !== null && track.rtcpPort !== undefined) {
            const value = track.rtcpPort;
            if (!Number.isInteger(value) || value < 1 || value > 65535) {
                throw new Error(`BRO start response ${kind}.rtcpPort must be an integer between 1 and 65535 or null`);
            }
        }
    }
    return payload;
}

/**
 * True when two validated BRO start payloads describe the SAME RTP transport
 * (identical ports, rtcpPorts, payloadTypes and ssrcs for both tracks).
 */
function sameIngestTransport(a, b) {
    if (!a || !b) return false;
    for (const kind of ['video', 'audio']) {
        const left = a[kind];
        const right = b[kind];
        if (!left || !right) return false;
        if (
            left.port !== right.port ||
            left.rtcpPort !== right.rtcpPort ||
            left.payloadType !== right.payloadType ||
            left.ssrc !== right.ssrc
        ) {
            return false;
        }
    }
    return true;
}

class Reconciler {
    /**
     * @param {object} options
     * @param {object} options.config adapter config
     * @param {object} options.log structured logger
     * @param {Function} [options.fetchImpl] injectable fetch (tests)
     * @param {Function} [options.spawnFfmpegImpl] injectable spawn (tests)
     * @param {Function} [options.now] injectable clock (tests)
     */
    constructor({ config, log, fetchImpl, spawnFfmpegImpl, now }) {
        this.config = config;
        this.log = log;
        this.fetchImpl = fetchImpl || globalThis.fetch.bind(globalThis);
        this.spawnFfmpegImpl = spawnFfmpegImpl || null;
        this.now = now || Date.now;

        /** @type {Map<string, object>} broadcastId -> state */
        this.states = new Map();
        /** @type {Map<string, number>} broadcastId -> next allowed cap-warning ts */
        this.capThrottleAt = new Map();
        this.timer = null;
        this.busy = false;
        this.shuttingDown = false;

        // health cache, updated every cycle (read by /healthz)
        this.health = { mediamtxReachable: false, broReachable: false };
    }

    start() {
        this.cycle(); // first run immediately, errors are contained
        this.timer = setInterval(() => this.cycle(), this.config.reconcileIntervalMs);
        this.timer.unref?.();
    }

    async stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.shuttingDown = true;
        const teardowns = [];
        for (const [broadcastId, state] of this.states) {
            teardowns.push(this.teardown(broadcastId, state));
        }
        await Promise.allSettled(teardowns);
    }

    getStatus() {
        let activeIngests = 0;
        for (const state of this.states.values()) {
            if (state.phase === 'running') activeIngests += 1;
        }
        return {
            activeIngests,
            mediamtxReachable: this.health.mediamtxReachable,
            broReachable: this.health.broReachable,
        };
    }

    async cycle() {
        if (this.busy || this.shuttingDown) return;
        this.busy = true;
        try {
            const active = await this.listActivePaths();
            if (active !== null) {
                for (const broadcastId of active.keys()) {
                    if (this.states.has(broadcastId)) continue;
                    if (this.countIngestSlots() >= this.config.maxConcurrentIngests) {
                        this.warnCapThrottled(broadcastId);
                        continue;
                    }
                    this.log.info('new active mediamtx path, starting ingest', { broadcastId });
                    this.states.set(broadcastId, this.newState(broadcastId));
                }
                for (const [broadcastId, state] of this.states) {
                    if (!active.has(broadcastId) && state.phase !== 'stopping') {
                        this.log.info('mediamtx path gone, stopping ingest', { broadcastId });
                        this.capThrottleAt.delete(broadcastId);
                        this.teardown(broadcastId, state).catch((err) =>
                            this.log.error('teardown failed', { broadcastId, error: err.message })
                        );
                    }
                }
            }
            await this.checkRunningIngests();
            await this.progressStates();
        } catch (err) {
            this.log.error('reconcile cycle failed', { error: err.message });
        } finally {
            this.busy = false;
        }
    }

    /** Occupied ingest slots: every tracked state that is not stopping. */
    countIngestSlots() {
        let slots = 0;
        for (const state of this.states.values()) {
            if (state.phase !== 'stopping') slots += 1;
        }
        return slots;
    }

    /** Cap reached: error-level warning, throttled once per path per cooldown. */
    warnCapThrottled(broadcastId) {
        const now = this.now();
        if (now < (this.capThrottleAt.get(broadcastId) || 0)) return;
        this.capThrottleAt.set(broadcastId, now + CAP_WARN_COOLDOWN_MS);
        this.log.error('max concurrent ingests reached, deferring new ingest', {
            broadcastId,
            maxConcurrentIngests: this.config.maxConcurrentIngests,
            retryInMs: CAP_WARN_COOLDOWN_MS,
        });
    }

    newState(broadcastId) {
        return {
            broadcastId,
            phase: 'pending', // pending -> running -> stopping
            ingest: null,
            proc: null,
            audioOptional: false,
            startedAt: 0,
            lastStatusCheckAt: 0,
            startAttempts: 0,
            nextStartAttemptAt: 0,
            restartAttempts: 0,
            nextRestartAt: 0,
            tearingDown: false,
        };
    }

    /** Advance pending starts and pending FFmpeg restarts. */
    async progressStates() {
        for (const [broadcastId, state] of this.states) {
            const now = this.now();
            if (state.phase === 'pending' && now >= state.nextStartAttemptAt) {
                await this.tryStart(broadcastId, state);
            } else if (state.phase === 'running' && state.proc === null && now >= state.nextRestartAt) {
                await this.tryStart(broadcastId, state, { isRestart: true });
            }
        }
    }

    /**
     * BRO start (idempotent) + FFmpeg spawn. Used for the initial start and
     * for restarts after crashes (re-POST keeps the transport contract fresh
     * in case BRO restarted in between).
     */
    async tryStart(broadcastId, state, { isRestart = false } = {}) {
        let ingest;
        try {
            ingest = await this.broStart(broadcastId);
            this.health.broReachable = true;
        } catch (err) {
            this.health.broReachable = false;
            if (isRestart) {
                state.restartAttempts += 1;
                const delay = backoffDelay(state.restartAttempts);
                state.nextRestartAt = this.now() + delay;
                this.log.warn('BRO start failed before ffmpeg restart, backing off', {
                    broadcastId,
                    error: err.message,
                    retryInMs: delay,
                });
            } else {
                state.startAttempts += 1;
                let delay = backoffDelay(state.startAttempts);
                if (state.startAttempts >= BACKOFF_LADDER_MS.length) {
                    // burst exhausted -> long cooldown before the next burst
                    state.startAttempts = 0;
                    delay = START_RETRY_COOLDOWN_MS;
                    this.log.warn('BRO start keeps failing, entering cooldown', {
                        broadcastId,
                        error: err.message,
                        cooldownMs: delay,
                    });
                } else {
                    this.log.warn('BRO start failed, retrying', {
                        broadcastId,
                        error: err.message,
                        retryInMs: delay,
                    });
                }
                state.nextStartAttemptAt = this.now() + delay;
            }
            return;
        }

        const previousIngest = state.ingest;
        state.ingest = ingest;
        state.startAttempts = 0;
        if (!isRestart) state.restartAttempts = 0;

        // The spawn below always builds its argv from the FRESH response, so
        // the state mirrors the ports/SSRCs ffmpeg actually uses. When a
        // restart POST returned a changed transport (e.g. BRO restarted in
        // between and allocated new ports), make that visible in the logs.
        if (isRestart && previousIngest && !sameIngestTransport(previousIngest, ingest)) {
            this.log.warn('BRO returned a changed ingest transport (ports/ssrc), ffmpeg restarts with the new args', {
                broadcastId,
            });
        }

        try {
            this.spawnIngest(broadcastId, state);
            state.phase = 'running';
            if (isRestart) {
                this.log.info('ffmpeg restarted', { broadcastId, audioOptional: state.audioOptional });
            } else {
                this.log.info('ingest started', { broadcastId });
            }
        } catch (err) {
            // Unrecoverable local problem (bad contract / spawn failure)
            this.log.error('failed to spawn ffmpeg, stopping ingest', { broadcastId, error: err.message });
            this.teardown(broadcastId, state).catch(() => {});
        }
    }

    spawnIngest(broadcastId, state) {
        const ingest = { ...state.ingest, broadcastId, audioOptional: state.audioOptional };
        const args = buildFfmpegArgs(ingest, this.config); // throws on bad contract

        const spawnImpl = this.spawnFfmpegImpl || spawnFfmpegProcess;
        const proc = spawnImpl({
            ffmpegPath: this.config.ffmpegPath,
            args,
            log: this.log,
            broadcastId,
        });

        state.proc = proc;
        state.startedAt = this.now();
        // The just-POSTed ingest is definitely listed on BRO; delay the first
        // re-attach status check by one full interval.
        state.lastStatusCheckAt = this.now();

        let exitHandled = false;
        const onExit = (code) => {
            if (exitHandled) return;
            exitHandled = true;
            this.handleFfmpegExit(broadcastId, state, code, proc.getStderrTail ? proc.getStderrTail() : '');
        };
        proc.child.once('exit', onExit);
        proc.child.once('error', (err) => {
            this.log.error('ffmpeg process error', { broadcastId, error: err.message });
            onExit(null);
        });
    }

    handleFfmpegExit(broadcastId, state, code, stderrTail) {
        state.proc = null;
        if (state.tearingDown || this.shuttingDown) return;

        // Learned flag: source has no audio track -> retry with optional map
        if (!state.audioOptional && stderrIndicatesMissingAudio(stderrTail)) {
            state.audioOptional = true;
            state.nextRestartAt = this.now(); // immediate restart
            this.log.warn('source has no audio track, restarting with optional audio map', { broadcastId });
            return;
        }

        const runtimeMs = this.now() - state.startedAt;
        if (runtimeMs >= STABLE_RUNTIME_MS) {
            state.restartAttempts = 0; // stable for 5 min -> reset the ladder
        } else {
            state.restartAttempts += 1;
        }
        const delay = backoffDelay(state.restartAttempts);
        state.nextRestartAt = this.now() + delay;
        this.log.warn('ffmpeg exited, will restart', {
            broadcastId,
            code: code === null ? 'signal/error' : code,
            runtimeMs,
            restartInMs: delay,
        });
    }

    /** POST /api/v1/external-ingest/start on BRO (Bearer, idempotent). */
    async broStart(broadcastId) {
        const res = await this.fetchImpl(`${this.config.broBaseUrl}/api/v1/external-ingest/start`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.config.ingestSecret}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ broadcastId }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`BRO start responded HTTP ${res.status}`);
        }
        return validateIngestResponse(await res.json());
    }

    /** POST /api/v1/external-ingest/stop on BRO (best effort). */
    async broStop(broadcastId) {
        const res = await this.fetchImpl(`${this.config.broBaseUrl}/api/v1/external-ingest/stop`, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${this.config.ingestSecret}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ broadcastId }),
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
            this.log.warn('BRO stop call failed', { broadcastId, status: res.status });
        }
    }

    /**
     * GET /api/v1/external-ingest/status on BRO; returns the Set of active
     * broadcastIds. Throws on HTTP errors and on a malformed payload (a
     * malformed body is not a positive signal and is treated as transient).
     */
    async broStatusActiveIds() {
        const res = await this.fetchImpl(`${this.config.broBaseUrl}/api/v1/external-ingest/status`, {
            headers: {
                authorization: `Bearer ${this.config.ingestSecret}`,
                accept: 'application/json',
            },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!res.ok) {
            throw new Error(`BRO status responded HTTP ${res.status}`);
        }
        const payload = await res.json();
        if (!payload || typeof payload !== 'object' || !Array.isArray(payload.ingests)) {
            throw new Error('BRO status response has no ingests array');
        }
        const ids = new Set();
        for (const entry of payload.ingests) {
            if (entry && typeof entry === 'object' && typeof entry.broadcastId === 'string') {
                ids.add(entry.broadcastId);
            }
        }
        return ids;
    }

    /**
     * BRO-restart re-attach: at most every STATUS_CHECK_INTERVAL_MS per
     * running ingest, verify via the status endpoint that BRO still lists
     * the broadcastId. Only a POSITIVE missing signal (successful listing
     * without the id) triggers the teardown; the cleared state lets the
     * normal start path re-run with fresh ports/SSRCs. Transient failures
     * skip this cycle (debug) and never tear anything down.
     */
    async checkRunningIngests() {
        const now = this.now();
        const due = [];
        for (const [broadcastId, state] of this.states) {
            if (state.phase === 'running' && now - state.lastStatusCheckAt >= STATUS_CHECK_INTERVAL_MS) {
                state.lastStatusCheckAt = now;
                due.push([broadcastId, state]);
            }
        }
        if (due.length === 0) return;

        let activeIds;
        try {
            activeIds = await this.broStatusActiveIds();
            this.health.broReachable = true;
        } catch (err) {
            // Tolerance: one failed GET = skip this cycle entirely.
            this.log.debug('BRO status check failed, skipping this cycle', { error: err.message });
            return;
        }

        for (const [broadcastId, state] of due) {
            if (!activeIds.has(broadcastId)) {
                this.log.warn('BRO status no longer lists this ingest, re-attaching with a fresh start', {
                    broadcastId,
                });
                try {
                    await this.teardown(broadcastId, state);
                } catch (err) {
                    this.log.error('re-attach teardown failed', { broadcastId, error: err.message });
                }
            }
        }
    }

    /**
     * List mediamtx paths. Returns Map(broadcastId -> {sourceType}) or null
     * when the API is unreachable (unknown state -> no teardown decisions).
     */
    async listActivePaths() {
        try {
            const res = await this.fetchImpl(`${this.config.mediamtxApiBase}/v3/paths/list`, {
                headers: { accept: 'application/json' },
                signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
            });
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }
            const active = extractActiveBroadcastIds(await res.json());
            this.health.mediamtxReachable = true;
            return active;
        } catch (err) {
            this.health.mediamtxReachable = false;
            this.log.warn('mediamtx paths list failed, keeping current ingests', { error: err.message });
            return null;
        }
    }

    /** TERM the process, KILL after the grace period, wait for exit. */
    stopProcess(state) {
        return new Promise((resolve) => {
            const proc = state.proc;
            if (!proc || proc.child.exitCode !== null || proc.child.signalCode !== null) {
                resolve();
                return;
            }
            const killTimer = setTimeout(() => {
                try {
                    proc.child.kill('SIGKILL');
                } catch {
                    /* already gone */
                }
            }, FFMPEG_KILL_GRACE_MS);
            proc.child.once('exit', () => {
                clearTimeout(killTimer);
                resolve();
            });
            try {
                proc.child.kill('SIGTERM');
            } catch {
                clearTimeout(killTimer);
                resolve();
            }
        });
    }

    /** Full teardown for one ingest: ffmpeg TERM/KILL + BRO stop + cleanup. */
    async teardown(broadcastId, state) {
        if (state.tearingDown) return;
        state.tearingDown = true;
        state.phase = 'stopping';
        try {
            await this.stopProcess(state);
        } finally {
            state.proc = null;
        }
        try {
            await this.broStop(broadcastId);
        } catch (err) {
            this.log.warn('BRO stop errored during teardown', { broadcastId, error: err.message });
        }
        this.states.delete(broadcastId);
        this.log.info('ingest stopped', { broadcastId });
    }
}

module.exports = {
    Reconciler,
    extractActiveBroadcastIds,
    validateIngestResponse,
    sameIngestTransport,
    PUBLISHER_SOURCE_TYPES,
    LIVE_PATH_RE,
};
