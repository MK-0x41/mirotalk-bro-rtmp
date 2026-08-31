'use strict';

/**
 * Unit tests for app/rooms-routes.js.
 * Stubs express + ./logs via Module._load; injects fake auth/ingest handlers
 * and a REAL app/rooms.js registry. No HTTP server, no mediasoup, no network.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const origLoad = Module._load;
const logInstances = {};

function FakeRouter() {
    const reg = { middlewares: [], routes: {} };
    reg.use = (fn) => {
        reg.middlewares.push(fn);
    };
    reg.post = (p, fn) => {
        reg.routes[`POST ${p}`] = fn;
    };
    reg.get = (p, fn) => {
        reg.routes[`GET ${p}`] = fn;
    };
    reg.delete = (p, fn) => {
        reg.routes[`DELETE ${p}`] = fn;
    };
    return reg;
}

class FakeLogs {
    constructor(appName) {
        this.appName = appName;
        this.entries = [];
        logInstances[appName] = this;
    }
    debug(msg, op) {
        this.entries.push({ level: 'debug', msg, op });
    }
    info(msg, op) {
        this.entries.push({ level: 'info', msg, op });
    }
    warn(msg, op) {
        this.entries.push({ level: 'warn', msg, op });
    }
    error(msg, op) {
        this.entries.push({ level: 'error', msg, op });
    }
}

Module._load = function (request, parent, isMain) {
    if (request === 'express') return { Router: FakeRouter };
    if (request === './logs') return FakeLogs;
    return origLoad.call(this, request, parent, isMain);
};

const {
    createRoomsRouter,
    DEFAULT_ADMIN_TOKEN_DENYLIST,
    isValidRoomId,
    getBearerToken,
    AuthRateLimiter,
    MAX_TOKEN_LENGTH,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_ATTEMPTS,
} = require('../app/rooms-routes');
const { createRoomRegistry } = require('../app/rooms');

const ADMIN = 'fake-admin-token-for-rooms-tests';
const DEFAULT_TOKEN = 'mirotalkbro_default_admin_token';
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_64_ANYWHERE = /[0-9a-f]{64}/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

function mkReq({
    auth = `Bearer ${ADMIN}`,
    body,
    params,
    path,
    host = 'broadcast.example',
    hostname,
    ip = '10.0.0.9',
    protocol = 'https',
} = {}) {
    const headers = { host };
    if (auth) headers.authorization = auth;
    const derivedHostname = typeof hostname === 'string' ? hostname : String(host).split(':')[0];
    return {
        headers,
        hostname: derivedHostname,
        ip,
        path: path || '/',
        body,
        params: params || {},
        protocol,
        get(name) {
            if (typeof name !== 'string') return undefined;
            return headers[name.toLowerCase()];
        },
    };
}

function mkRes() {
    const res = { statusCode: null, body: null, ended: false };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
        return res;
    };
    res.end = () => {
        res.ended = true;
        return res;
    };
    return res;
}

async function runRoute(router, routeKey, req) {
    const res = mkRes();
    for (const mw of router.middlewares) {
        let calledNext = false;
        await mw(req, res, () => {
            calledNext = true;
        });
        if (!calledNext) return res;
    }
    if (router.routes[routeKey]) {
        await router.routes[routeKey](req, res);
    }
    return res;
}

function loggedText() {
    const logger = logInstances['rooms'];
    return logger ? JSON.stringify(logger.entries) : '';
}

function hex64Hits(value) {
    const hits = [];
    const walk = (v, p) => {
        if (typeof v === 'string' && HEX_64_ANYWHERE.test(v)) hits.push(p);
        else if (Array.isArray(v)) v.forEach((item, i) => walk(item, `${p}[${i}]`));
        else if (v && typeof v === 'object') {
            for (const [k, child] of Object.entries(v)) walk(child, p ? `${p}.${k}` : k);
        }
    };
    walk(value, '');
    return hits;
}

function makeRouter({
    adminToken = ADMIN,
    rtmpIngestUrl = '',
    maxRtmpRooms,
    registry,
    getIngestStatus,
    stopExternalIngest,
    isValidAdminToken,
    rateLimiter,
    now,
} = {}) {
    const roomRegistry = registry || createRoomRegistry({ maxRtmpRooms });
    const stopSpy = { calls: [], impl: stopExternalIngest };
    const router = createRoomsRouter({
        config: { adminToken, rtmpIngestUrl },
        registry: roomRegistry,
        isValidAdminToken:
            isValidAdminToken ||
            ((provided) => provided === ADMIN),
        getIngestStatus: getIngestStatus || (() => []),
        stopExternalIngest:
            stopSpy.impl ||
            (async (id) => {
                stopSpy.calls.push(id);
            }),
        rateLimiter,
        now,
    });
    return { router, registry: roomRegistry, stopSpy };
}

const ALL_ROUTES = [
    { key: 'POST /', req: () => mkReq({ body: { name: 'x', sourceType: 'camera' } }) },
    { key: 'GET /', req: () => mkReq({ path: '/' }) },
    { key: 'GET /:id', req: () => mkReq({ path: `/${MISSING_ID}`, params: { id: MISSING_ID } }) },
    {
        key: 'POST /:id/rotate-key',
        req: () => mkReq({ path: `/${MISSING_ID}/rotate-key`, params: { id: MISSING_ID } }),
    },
    { key: 'DELETE /:id', req: () => mkReq({ path: `/${MISSING_ID}`, params: { id: MISSING_ID } }) },
];

describe('rooms-routes helpers', () => {
    it('exports the documented default-admin-token denylist', () => {
        assert.deepEqual(DEFAULT_ADMIN_TOKEN_DENYLIST, ['mirotalkbro_default_admin_token']);
        assert.equal(isValidRoomId(MISSING_ID), true);
        assert.equal(isValidRoomId('not-a-uuid'), false);
    });
});

describe('rooms-routes auth gate', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('returns 401 on every route when the bearer is missing or invalid', async () => {
        const { router } = makeRouter();
        for (const route of ALL_ROUTES) {
            const base = route.req();
            const noAuth = await runRoute(
                router,
                route.key,
                mkReq({ auth: null, body: base.body, params: base.params, path: base.path })
            );
            const bad = await runRoute(
                router,
                route.key,
                mkReq({
                    auth: 'Bearer wrong-admin-token-000',
                    body: base.body,
                    params: base.params,
                    path: base.path,
                })
            );
            assert.equal(noAuth.statusCode, 401, route.key + ' missing');
            assert.deepEqual(noAuth.body, { error: 'Unauthorized' });
            assert.equal(bad.statusCode, 401, route.key + ' invalid');
            assert.deepEqual(bad.body, { error: 'Unauthorized' });
        }
    });

    it('returns 503 on every route when the admin token is unset', async () => {
        const { router } = makeRouter({ adminToken: '' });
        for (const route of ALL_ROUTES) {
            const res = await runRoute(router, route.key, route.req());
            assert.equal(res.statusCode, 503, route.key);
            assert.deepEqual(res.body, { error: 'Rooms API unavailable' });
        }
    });

    it('returns 503 on every route when the configured token is the documented default', async () => {
        const { router } = makeRouter({ adminToken: DEFAULT_TOKEN });
        for (const route of ALL_ROUTES) {
            const res = await runRoute(
                router,
                route.key,
                mkReq({ auth: `Bearer ${DEFAULT_TOKEN}`, body: { name: 'x', sourceType: 'camera' }, params: { id: MISSING_ID } })
            );
            assert.equal(res.statusCode, 503, route.key);
            assert.deepEqual(res.body, { error: 'Rooms API unavailable' });
        }
        const upper = makeRouter({ adminToken: DEFAULT_TOKEN.toUpperCase() });
        const res = await runRoute(upper.router, 'GET /', mkReq({ auth: `Bearer ${ADMIN}` }));
        assert.equal(res.statusCode, 503);
    });
});

describe('POST / rooms', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('returns 201 with the rtmp create contract shape derived from the request host', async () => {
        const { router, registry } = makeRouter();
        const res = await runRoute(
            router,
            'POST /',
            mkReq({
                body: { name: 'Live Studio', sourceType: 'rtmp', extra: 'ignored' },
                host: 'pub.example:3016',
                hostname: 'pub.example',
            })
        );
        assert.equal(res.statusCode, 201);
        assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'id', 'name', 'rtmp', 'sourceType', 'viewerUrl']);
        assert.match(res.body.id, UUID_V4);
        assert.equal(res.body.name, 'Live Studio');
        assert.equal(res.body.sourceType, 'rtmp');
        assert.equal(res.body.viewerUrl, `https://pub.example:3016/viewer?id=${res.body.id}&name=viewer`);
        assert.deepEqual(Object.keys(res.body.rtmp).sort(), ['ingestServer', 'note', 'streamKey']);
        // hostname (no port) is used for RTMPS :1935 even when Host includes the web port.
        assert.equal(res.body.rtmp.ingestServer, 'rtmps://pub.example:1935/live');
        const keyMatch = res.body.rtmp.streamKey.match(new RegExp(`^${res.body.id}\\?token=([0-9a-f]{64})$`));
        assert.ok(keyMatch, 'streamKey must be <id>?token=<64hex>');
        assert.match(keyMatch[1], HEX_64);
        assert.equal(typeof res.body.rtmp.note, 'string');
        assert.ok(res.body.rtmp.note.length > 0);
        assert.equal(registry.validateRtmpKey(res.body.id, keyMatch[1]), true);
    });

    it('lets RTMP_INGEST_URL override the host-derived ingest server', async () => {
        const { router } = makeRouter({ rtmpIngestUrl: 'rtmps://custom-ingest.example:1935/live' });
        const res = await runRoute(router, 'POST /', mkReq({ body: { name: 'Override', sourceType: 'rtmp' } }));
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.rtmp.ingestServer, 'rtmps://custom-ingest.example:1935/live');
    });

    it('returns rtmp:null for a camera room', async () => {
        const { router } = makeRouter();
        const res = await runRoute(router, 'POST /', mkReq({ body: { name: 'Cam', sourceType: 'camera' } }));
        assert.equal(res.statusCode, 201);
        assert.equal(res.body.sourceType, 'camera');
        assert.equal(res.body.rtmp, null);
        assert.equal(HEX_64_ANYWHERE.test(JSON.stringify(res.body)), false);
    });

    it('returns 409 when the RTMP room cap is reached', async () => {
        const { router } = makeRouter({ maxRtmpRooms: 1 });
        const first = await runRoute(router, 'POST /', mkReq({ body: { name: 'one', sourceType: 'rtmp' } }));
        assert.equal(first.statusCode, 201);
        const second = await runRoute(router, 'POST /', mkReq({ body: { name: 'two', sourceType: 'rtmp' } }));
        assert.equal(second.statusCode, 409);
        assert.deepEqual(second.body, { error: 'Too many active RTMP rooms' });
    });

    it('returns 400 for invalid sourceType or name', async () => {
        const { router } = makeRouter();
        const badType = await runRoute(router, 'POST /', mkReq({ body: { name: 'x', sourceType: 'obs' } }));
        assert.equal(badType.statusCode, 400);
        assert.deepEqual(badType.body, { error: 'Invalid sourceType' });
        const badName = await runRoute(router, 'POST /', mkReq({ body: { name: '   ', sourceType: 'camera' } }));
        assert.equal(badName.statusCode, 400);
        assert.deepEqual(badName.body, { error: 'Invalid room name' });
        const noBody = await runRoute(router, 'POST /', mkReq({ body: undefined }));
        assert.equal(noBody.statusCode, 400);
    });
});

describe('GET list and GET /:id', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('lists and fetches rooms without key material and wires ingestActive from getIngestStatus', async () => {
        const ingestStatus = [];
        const { router } = makeRouter({
            getIngestStatus: () => ingestStatus,
        });
        const createdRtmp = await runRoute(router, 'POST /', mkReq({ body: { name: 'Live', sourceType: 'rtmp' } }));
        const createdCam = await runRoute(router, 'POST /', mkReq({ body: { name: 'Cam', sourceType: 'camera' } }));
        assert.equal(createdRtmp.statusCode, 201);
        assert.equal(createdCam.statusCode, 201);
        const rtmpId = createdRtmp.body.id;
        const cameraId = createdCam.body.id;
        const key = createdRtmp.body.rtmp.streamKey.split('token=')[1];
        ingestStatus.push({ broadcastId: rtmpId, startedAt: '2026-01-01T00:00:00.000Z' });

        const list = await runRoute(router, 'GET /', mkReq({ path: '/' }));
        assert.equal(list.statusCode, 200);
        assert.ok(Array.isArray(list.body.rooms));
        assert.equal(list.body.rooms.length, 2);
        const live = list.body.rooms.find((r) => r.id === rtmpId);
        const cam = list.body.rooms.find((r) => r.id === cameraId);
        assert.equal(live.ingestActive, true);
        assert.equal(live.rtmp, null);
        assert.equal(cam.ingestActive, false);
        assert.equal(cam.rtmp, null);
        assert.deepEqual(hex64Hits(list.body), []);
        assert.equal(JSON.stringify(list.body).includes(key), false);
        assert.equal(JSON.stringify(list.body).includes('keyHash'), false);

        const one = await runRoute(router, 'GET /:id', mkReq({ path: `/${rtmpId}`, params: { id: rtmpId } }));
        assert.equal(one.statusCode, 200);
        assert.equal(one.body.id, rtmpId);
        assert.equal(one.body.ingestActive, true);
        assert.equal(one.body.rtmp, null);
        assert.deepEqual(hex64Hits(one.body), []);
        assert.equal(JSON.stringify(one.body).includes(key), false);
    });

    it('returns 404 for a missing room and 400 for a bad id shape', async () => {
        const { router } = makeRouter();
        const missing = await runRoute(router, 'GET /:id', mkReq({ path: `/${MISSING_ID}`, params: { id: MISSING_ID } }));
        assert.equal(missing.statusCode, 404);
        assert.deepEqual(missing.body, { error: 'Room not found' });
        const bad = await runRoute(router, 'GET /:id', mkReq({ path: '/not-a-uuid', params: { id: 'not-a-uuid' } }));
        assert.equal(bad.statusCode, 400);
        assert.deepEqual(bad.body, { error: 'Invalid room id' });
    });
});

describe('POST /:id/rotate-key', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('returns 200 {id, streamKey} and invalidates the old key via the registry', async () => {
        const { router, registry } = makeRouter();
        const created = await runRoute(router, 'POST /', mkReq({ body: { name: 'Live', sourceType: 'rtmp' } }));
        const id = created.body.id;
        const oldKey = created.body.rtmp.streamKey.split('token=')[1];
        const res = await runRoute(
            router,
            'POST /:id/rotate-key',
            mkReq({ path: `/${id}/rotate-key`, params: { id } })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ['id', 'streamKey']);
        assert.equal(res.body.id, id);
        const match = res.body.streamKey.match(new RegExp(`^${id}\\?token=([0-9a-f]{64})$`));
        assert.ok(match);
        assert.notEqual(match[1], oldKey);
        assert.equal(registry.validateRtmpKey(id, oldKey), false);
        assert.equal(registry.validateRtmpKey(id, match[1]), true);
    });

    it('returns 404 when missing and 409 for a non-rtmp room', async () => {
        const { router } = makeRouter();
        const createdCam = await runRoute(router, 'POST /', mkReq({ body: { name: 'Cam', sourceType: 'camera' } }));
        const camera = createdCam.body;
        const missing = await runRoute(
            router,
            'POST /:id/rotate-key',
            mkReq({ path: `/${MISSING_ID}/rotate-key`, params: { id: MISSING_ID } })
        );
        assert.equal(missing.statusCode, 404);
        const notRtmp = await runRoute(
            router,
            'POST /:id/rotate-key',
            mkReq({ path: `/${camera.id}/rotate-key`, params: { id: camera.id } })
        );
        assert.equal(notRtmp.statusCode, 409);
        assert.deepEqual(notRtmp.body, { error: 'Room is not an RTMP room' });
    });
});

describe('DELETE /:id', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('stops an active ingest, returns 204, and 404 when missing', async () => {
        const stopCalls = [];
        let roomId;
        const { router, registry } = makeRouter({
            getIngestStatus: () => (roomId ? [{ broadcastId: roomId }] : []),
            stopExternalIngest: async (id) => {
                stopCalls.push(id);
            },
        });
        const created = await runRoute(router, 'POST /', mkReq({ body: { name: 'Live', sourceType: 'rtmp' } }));
        assert.equal(created.statusCode, 201);
        roomId = created.body.id;
        const res = await runRoute(router, 'DELETE /:id', mkReq({ path: `/${roomId}`, params: { id: roomId } }));
        assert.equal(res.statusCode, 204);
        assert.equal(res.ended, true);
        assert.deepEqual(stopCalls, [roomId]);
        assert.equal(registry.getRoom(roomId), null);

        const missing = await runRoute(
            router,
            'DELETE /:id',
            mkReq({ path: `/${MISSING_ID}`, params: { id: MISSING_ID } })
        );
        assert.equal(missing.statusCode, 404);
        assert.deepEqual(missing.body, { error: 'Room not found' });
    });
});

describe('rooms-routes log redaction', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    it('does not write secrets, tokens, or stream keys into captured log output', async () => {
        const { router } = makeRouter();
        const created = await runRoute(router, 'POST /', mkReq({ body: { name: 'Live', sourceType: 'rtmp' } }));
        const key = created.body.rtmp.streamKey.split('token=')[1];
        await runRoute(router, 'GET /', mkReq({ path: '/' }));
        await runRoute(
            router,
            'POST /:id/rotate-key',
            mkReq({ path: `/${created.body.id}/rotate-key`, params: { id: created.body.id } })
        );
        await runRoute(router, 'POST /', mkReq({ auth: 'Bearer wrong-admin-token-000', body: { name: 'x', sourceType: 'camera' } }));

        const text = loggedText();
        assert.equal(text.includes(ADMIN), false);
        assert.equal(text.includes('wrong-admin-token-000'), false);
        assert.equal(text.includes(key), false);
        assert.equal(text.includes('Bearer '), false);
        assert.equal(text.includes(created.body.rtmp.streamKey), false);
    });
});

describe('rooms-routes getBearerToken', () => {
    it('returns 401 when the bearer token is longer than 4096 characters', async () => {
        const overlong = 'a'.repeat(MAX_TOKEN_LENGTH + 1);
        assert.equal(getBearerToken({ headers: { authorization: `Bearer ${overlong}` } }), null);
        assert.equal(
            getBearerToken({ headers: { authorization: `Bearer ${'b'.repeat(MAX_TOKEN_LENGTH)}` } }),
            'b'.repeat(MAX_TOKEN_LENGTH)
        );

        const { router } = makeRouter();
        const res = await runRoute(
            router,
            'POST /',
            mkReq({ auth: `Bearer ${overlong}`, body: { name: 'x', sourceType: 'camera' } })
        );
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { error: 'Unauthorized' });
    });
});

describe('rooms-routes auth rate limit', () => {
    beforeEach(() => {
        const logger = logInstances['rooms'];
        if (logger) logger.entries.length = 0;
    });

    async function failedAuth(router, ip = '10.0.0.9') {
        return runRoute(
            router,
            'POST /',
            mkReq({
                auth: 'Bearer wrong-admin-token-000',
                body: { name: 'x', sourceType: 'camera' },
                ip,
            })
        );
    }

    it('returns 429 on the 11th failed-auth POST from the same ip', async () => {
        const { router } = makeRouter();
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
            const res = await failedAuth(router);
            assert.equal(res.statusCode, 401, `failure ${i + 1} should be 401`);
        }
        const blocked = await failedAuth(router);
        assert.equal(blocked.statusCode, 429);
        assert.deepEqual(blocked.body, { error: 'Too many attempts' });
    });

    it('resets the bucket after a successful auth', async () => {
        const { router } = makeRouter();
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS - 1; i += 1) {
            const res = await failedAuth(router);
            assert.equal(res.statusCode, 401);
        }
        const ok = await runRoute(router, 'POST /', mkReq({ body: { name: 'Reset', sourceType: 'camera' } }));
        assert.equal(ok.statusCode, 201);

        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
            const res = await failedAuth(router);
            assert.equal(res.statusCode, 401, `post-reset failure ${i + 1} should be 401`);
        }
        const blocked = await failedAuth(router);
        assert.equal(blocked.statusCode, 429);
    });

    it('expires the window using the injectable now clock (no real wait)', async () => {
        let nowMs = 1_000_000;
        const { router } = makeRouter({ now: () => nowMs });
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
            const res = await failedAuth(router);
            assert.equal(res.statusCode, 401);
        }
        const blocked = await failedAuth(router);
        assert.equal(blocked.statusCode, 429);

        nowMs += RATE_LIMIT_WINDOW_MS;
        const afterExpiry = await failedAuth(router);
        assert.equal(afterExpiry.statusCode, 401);
        assert.deepEqual(afterExpiry.body, { error: 'Unauthorized' });
    });

    it('does not count 503 misconfig responses toward the rate-limit bucket', async () => {
        const limiter = new AuthRateLimiter();
        const misconfigured = makeRouter({ adminToken: '', rateLimiter: limiter });
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS + 1; i += 1) {
            const res = await runRoute(
                misconfigured.router,
                'POST /',
                mkReq({ body: { name: 'x', sourceType: 'camera' } })
            );
            assert.equal(res.statusCode, 503);
        }
        assert.equal(limiter.entries.size, 0);
        assert.equal(limiter.isBlocked('10.0.0.9', Date.now()), false);

        const { router } = makeRouter({ rateLimiter: limiter });
        const firstFail = await failedAuth(router);
        assert.equal(firstFail.statusCode, 401);
        assert.equal(firstFail.statusCode !== 429, true);
    });

    it('does not rate-limit a different ip', async () => {
        const { router } = makeRouter();
        for (let i = 0; i < RATE_LIMIT_MAX_ATTEMPTS; i += 1) {
            const res = await failedAuth(router, '10.0.0.9');
            assert.equal(res.statusCode, 401);
        }
        const blocked = await failedAuth(router, '10.0.0.9');
        assert.equal(blocked.statusCode, 429);

        const other = await failedAuth(router, '10.0.0.8');
        assert.equal(other.statusCode, 401);
        assert.deepEqual(other.body, { error: 'Unauthorized' });
    });
});
