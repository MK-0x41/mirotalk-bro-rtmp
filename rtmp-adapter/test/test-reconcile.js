'use strict';

/**
 * Unit tests for reconcile.js pure helpers. No mediamtx, no BRO, no ffmpeg.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    extractActiveBroadcastIds,
    validateIngestResponse,
    sameIngestTransport,
    Reconciler,
    PUBLISHER_SOURCE_TYPES,
} = require('../src/reconcile');

function item(overrides = {}) {
    return {
        name: 'live/room1',
        ready: true,
        source: { type: 'rtmpConn' },
        ...overrides,
    };
}

describe('extractActiveBroadcastIds', () => {
    it('extracts live/<id> when ready is true and source is a publisher', () => {
        const active = extractActiveBroadcastIds({
            itemCount: 1,
            items: [item({ name: 'live/xyz', ready: true, source: { type: 'rtmpConn' } })],
        });
        assert.equal(active.size, 1);
        assert.deepEqual(active.get('xyz'), { sourceType: 'rtmpConn' });
    });

    it('treats available:true as ready (deprecated ready OR new available)', () => {
        const viaAvailable = extractActiveBroadcastIds({
            items: [item({ ready: false, available: true })],
        });
        assert.equal(viaAvailable.has('room1'), true);

        const viaReady = extractActiveBroadcastIds({
            items: [item({ ready: true, available: false })],
        });
        assert.equal(viaReady.has('room1'), true);

        const neither = extractActiveBroadcastIds({
            items: [item({ ready: false, available: false })],
        });
        assert.equal(neither.size, 0);
    });

    it('includes implemented publisher source.type variants and excludes others', () => {
        const publisherItems = [...PUBLISHER_SOURCE_TYPES].map((type, index) =>
            item({ name: `live/id${index}`, source: { type } })
        );
        const active = extractActiveBroadcastIds({ items: publisherItems });
        assert.equal(active.size, PUBLISHER_SOURCE_TYPES.size);

        const excluded = extractActiveBroadcastIds({
            items: [
                item({ name: 'live/pull', source: { type: 'rtmpSource' } }),
                item({ name: 'live/hls', source: { type: 'hlsSource' } }),
                item({ name: 'live/none', source: null }),
                item({ name: 'live/missing' , source: undefined }),
            ],
        });
        assert.equal(excluded.size, 0);
    });

    it('ignores non-live paths and leading-slash names', () => {
        const active = extractActiveBroadcastIds({
            items: [
                item({ name: 'vod/room1' }),
                item({ name: 'live' }),
                item({ name: '/live/room1' }),
                item({ name: 'live/room1/extra' }),
                item({ name: 'webrtc/room1' }),
            ],
        });
        assert.equal(active.size, 0);
    });

    it('returns an empty map for an empty list or missing items', () => {
        assert.equal(extractActiveBroadcastIds({ items: [] }).size, 0);
        assert.equal(extractActiveBroadcastIds({ itemCount: 0 }).size, 0);
        assert.equal(extractActiveBroadcastIds(null).size, 0);
        assert.equal(extractActiveBroadcastIds(undefined).size, 0);
        assert.equal(extractActiveBroadcastIds({ items: 'nope' }).size, 0);
    });

    it('skips malformed items without throwing', () => {
        const active = extractActiveBroadcastIds({
            items: [
                null,
                'x',
                1,
                {},
                { name: 12, ready: true, source: { type: 'rtmpConn' } },
                item({ name: 'live/ok' }),
            ],
        });
        assert.equal(active.size, 1);
        assert.ok(active.has('ok'));
    });
});

describe('validateIngestResponse', () => {
    function validPayload(overrides = {}) {
        return {
            broadcastId: 'room1',
            video: { port: 50000, rtcpPort: 50001, payloadType: 96, ssrc: 111111 },
            audio: { port: 50002, rtcpPort: null, payloadType: 111, ssrc: 222222 },
            ...overrides,
        };
    }

    it('accepts the BRO start contract including null rtcpPort', () => {
        const payload = validPayload();
        assert.equal(validateIngestResponse(payload), payload);
    });

    it('rejects a missing port', () => {
        const payload = validPayload();
        delete payload.video.port;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.port must be an integer/ });
    });

    it('rejects a string port', () => {
        const payload = validPayload();
        payload.audio.port = '50002';
        assert.throws(() => validateIngestResponse(payload), { message: /audio\.port must be an integer/ });
    });

    it('rejects NaN ssrc', () => {
        const payload = validPayload();
        payload.video.ssrc = Number.NaN;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.ssrc must be an integer/ });
    });

    it('rejects a missing track or invalid broadcastId', () => {
        assert.throws(() => validateIngestResponse(null), { message: /not an object/ });
        assert.throws(() => validateIngestResponse({ broadcastId: 'room1', video: validPayload().video }), {
            message: /misses track "audio"/,
        });
        assert.throws(() => validateIngestResponse(validPayload({ broadcastId: 'live/../x' })), {
            message: /no valid broadcastId/,
        });
    });

    it('rejects a negative port', () => {
        const payload = validPayload();
        payload.video.port = -1;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.port must be an integer/ });
    });

    it('rejects port 0', () => {
        const payload = validPayload();
        payload.video.port = 0;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.port must be an integer/ });
    });

    it('rejects port 65536', () => {
        const payload = validPayload();
        payload.audio.port = 65536;
        assert.throws(() => validateIngestResponse(payload), { message: /audio\.port must be an integer/ });
    });

    it('rejects rtcpPort 0', () => {
        const payload = validPayload();
        payload.video.rtcpPort = 0;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.rtcpPort must be an integer/ });
    });

    it('accepts null rtcpPort', () => {
        const payload = validPayload();
        payload.video.rtcpPort = null;
        payload.audio.rtcpPort = null;
        assert.equal(validateIngestResponse(payload), payload);
    });

    it('rejects payloadType 128', () => {
        const payload = validPayload();
        payload.video.payloadType = 128;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.payloadType must be an integer/ });
    });

    it('accepts payloadType 0', () => {
        const payload = validPayload();
        payload.audio.payloadType = 0;
        assert.equal(validateIngestResponse(payload), payload);
    });

    it('rejects ssrc 0', () => {
        const payload = validPayload();
        payload.video.ssrc = 0;
        assert.throws(() => validateIngestResponse(payload), { message: /video\.ssrc must be an integer/ });
    });

    it('accepts ssrc 0x7fffffff and rejects 0x80000000', () => {
        const accepted = validPayload();
        accepted.video.ssrc = 0x7fffffff;
        assert.equal(validateIngestResponse(accepted), accepted);
        assert.equal(accepted.video.ssrc, 2147483647);

        const rejected = validPayload();
        rejected.video.ssrc = 0x80000000;
        assert.throws(() => validateIngestResponse(rejected), { message: /video\.ssrc must be an integer/ });
        assert.equal(rejected.video.ssrc, 2147483648);
    });

    it('rejects ssrc 4294967296', () => {
        const payload = validPayload();
        payload.audio.ssrc = 4294967296;
        assert.throws(() => validateIngestResponse(payload), { message: /audio\.ssrc must be an integer/ });
    });
});

function ingestTracks(overrides = {}) {
    return {
        broadcastId: 'room1',
        video: { port: 50000, rtcpPort: 50001, payloadType: 96, ssrc: 111111, ...overrides.video },
        audio: { port: 50002, rtcpPort: null, payloadType: 111, ssrc: 222222, ...overrides.audio },
    };
}

describe('sameIngestTransport', () => {
    it('returns true when ports, rtcpPorts, payloadTypes and ssrcs match', () => {
        const left = ingestTracks();
        const right = ingestTracks();
        assert.equal(sameIngestTransport(left, right), true);
    });

    it('returns false when a port changes', () => {
        const left = ingestTracks();
        const right = ingestTracks({ video: { port: 50009 } });
        assert.equal(sameIngestTransport(left, right), false);
    });

    it('returns false for missing payloads', () => {
        assert.equal(sameIngestTransport(null, ingestTracks()), false);
        assert.equal(sameIngestTransport(ingestTracks(), undefined), false);
    });
});

function silentLog() {
    const entries = [];
    return {
        entries,
        error(msg, fields) {
            entries.push({ level: 'error', msg, fields });
        },
        warn(msg, fields) {
            entries.push({ level: 'warn', msg, fields });
        },
        info(msg, fields) {
            entries.push({ level: 'info', msg, fields });
        },
        debug(msg, fields) {
            entries.push({ level: 'debug', msg, fields });
        },
    };
}

function jsonRes(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    };
}

function adapterConfig(overrides = {}) {
    return {
        broBaseUrl: 'http://bro.test',
        ingestSecret: 'fake-ingest-secret-16',
        mediamtxApiBase: 'http://mtx.test',
        mediamtxRtmpSource: 'rtmp://mediamtx:19350',
        ffmpegPath: 'ffmpeg',
        videoBitrate: '2500k',
        audioBitrate: '128k',
        keyframeSeconds: 2,
        videoPreset: 'veryfast',
        broHost: 'bro.test',
        maxConcurrentIngests: 4,
        reconcileIntervalMs: 2000,
        ...overrides,
    };
}

describe('Reconciler exported seams', () => {
    it('defers a new path when MAX_CONCURRENT_INGESTS is reached', async () => {
        const log = silentLog();
        const fetchImpl = async (url) => {
            const target = String(url);
            if (target.includes('/v3/paths/list')) {
                return jsonRes({
                    items: [
                        { name: 'live/roomA', ready: true, source: { type: 'rtmpConn' } },
                        { name: 'live/roomB', ready: true, source: { type: 'rtmpConn' } },
                    ],
                });
            }
            if (target.includes('/external-ingest/start')) {
                return { ok: false, status: 503, json: async () => ({}) };
            }
            if (target.includes('/external-ingest/status')) {
                return jsonRes({ ingests: [] });
            }
            throw new Error('unexpected fetch');
        };

        const rec = new Reconciler({
            config: adapterConfig({ maxConcurrentIngests: 1 }),
            log,
            fetchImpl,
            now: () => 1000,
        });
        await rec.cycle();

        assert.equal(rec.states.has('roomA'), true);
        assert.equal(rec.states.has('roomB'), false);
        assert.ok(
            log.entries.some(
                (entry) => entry.level === 'error' && /max concurrent ingests reached/.test(entry.msg)
            )
        );
    });

    it('tears down a running ingest when BRO status positively omits it', async () => {
        const log = silentLog();
        let stopCalls = 0;
        const fetchImpl = async (url) => {
            const target = String(url);
            if (target.includes('/external-ingest/status')) {
                return jsonRes({ ingests: [{ broadcastId: 'other-room' }] });
            }
            if (target.includes('/external-ingest/stop')) {
                stopCalls += 1;
                return jsonRes({ stopped: true });
            }
            throw new Error('unexpected fetch');
        };

        const rec = new Reconciler({
            config: adapterConfig(),
            log,
            fetchImpl,
            now: () => 40_000,
        });
        rec.states.set('room1', {
            broadcastId: 'room1',
            phase: 'running',
            ingest: ingestTracks(),
            proc: null,
            lastStatusCheckAt: 0,
            tearingDown: false,
        });

        await rec.checkRunningIngests();
        assert.equal(rec.states.has('room1'), false);
        assert.equal(stopCalls, 1);
    });

    it('does not tear down on a transient BRO status failure', async () => {
        const log = silentLog();
        const fetchImpl = async (url) => {
            if (String(url).includes('/external-ingest/status')) {
                throw new Error('BRO status responded HTTP 502');
            }
            throw new Error('unexpected fetch');
        };

        const rec = new Reconciler({
            config: adapterConfig(),
            log,
            fetchImpl,
            now: () => 40_000,
        });
        rec.states.set('room1', {
            broadcastId: 'room1',
            phase: 'running',
            ingest: ingestTracks(),
            proc: null,
            lastStatusCheckAt: 0,
            tearingDown: false,
        });

        await rec.checkRunningIngests();
        assert.equal(rec.states.has('room1'), true);
        assert.equal(rec.states.get('room1').phase, 'running');
    });
});
