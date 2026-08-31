'use strict';

/**
 * Unit tests for app/external-ingest.js.
 * Stubs express + ./logs via Module._load; drives the real router and helpers.
 * No HTTP server, no mediasoup, no network.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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
    createExternalIngestRouter,
    isAuthorizedRequest,
    isValidBroadcastId,
    isExampleSecret,
    getBearerToken,
    EXAMPLE_SECRET_DENYLIST,
} = require('../app/external-ingest');

const SECRET = 'fake-valid-secret-0123456789';
const DENY_A = EXAMPLE_SECRET_DENYLIST[0];
const DENY_B = EXAMPLE_SECRET_DENYLIST[1];

function mkReq(auth, overrides = {}) {
    return {
        headers: { authorization: auth },
        ip: '10.0.0.9',
        path: '/start',
        body: {},
        ...overrides,
    };
}

function mkRes() {
    const res = { statusCode: null, body: null };
    res.status = (code) => {
        res.statusCode = code;
        return res;
    };
    res.json = (body) => {
        res.body = body;
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

function enabledRouter(handlers = {}) {
    return createExternalIngestRouter({
        config: { externalIngestEnabled: true, externalIngestSecret: SECRET },
        handlers: {
            createExternalIngest: async (broadcastId) => ({
                broadcastId,
                video: { port: 41000, rtcpPort: null, payloadType: 104, ssrc: 111111, profile: '42e01f' },
                audio: { port: 41002, rtcpPort: null, payloadType: 100, ssrc: 222222, profile: null },
            }),
            stopExternalIngest: async () => {},
            getExternalIngestStatus: () => [{ broadcastId: 'room1', startedAt: '2026-01-01T00:00:00.000Z' }],
            ...handlers,
        },
    });
}

function loggedText() {
    const logger = logInstances['external-ingest'];
    return logger ? JSON.stringify(logger.entries) : '';
}

describe('isValidBroadcastId', () => {
    it('accepts charset-and-length valid ids', () => {
        assert.equal(isValidBroadcastId('Room_1-2'), true);
        assert.equal(isValidBroadcastId('a'), true);
        assert.equal(isValidBroadcastId('A'.repeat(128)), true);
    });

    it('rejects empty, overlong, traversal and bad charset values', () => {
        assert.equal(isValidBroadcastId(''), false);
        assert.equal(isValidBroadcastId('x'.repeat(129)), false);
        assert.equal(isValidBroadcastId('../etc/passwd'), false);
        assert.equal(isValidBroadcastId('live/../escape'), false);
        assert.equal(isValidBroadcastId('bad id!'), false);
        assert.equal(isValidBroadcastId('room.1'), false);
        assert.equal(isValidBroadcastId(42), false);
        assert.equal(isValidBroadcastId(null), false);
    });
});

describe('getBearerToken / isAuthorizedRequest', () => {
    it('extracts a valid bearer token and rejects missing or malformed headers', () => {
        assert.equal(getBearerToken(mkReq(`Bearer ${SECRET}`)), SECRET);
        assert.equal(getBearerToken(mkReq('Bearer ')), null);
        assert.equal(getBearerToken(mkReq('Basic abc')), null);
        assert.equal(getBearerToken(mkReq(undefined)), null);
        assert.equal(getBearerToken({ headers: {} }), null);
        assert.equal(getBearerToken({ headers: { authorization: 12 } }), null);
    });

    it('authorizes via HMAC-then-timingSafeEqual for the correct secret only', () => {
        assert.equal(isAuthorizedRequest(mkReq(`Bearer ${SECRET}`), SECRET), true);
        assert.equal(isAuthorizedRequest(mkReq(`Bearer ${SECRET}x`), SECRET), false);
        assert.equal(isAuthorizedRequest(mkReq('Bearer '), SECRET), false);
        assert.equal(isAuthorizedRequest(mkReq('Basic abc'), SECRET), false);
        assert.equal(isAuthorizedRequest(mkReq(undefined), SECRET), false);
        assert.doesNotThrow(() => isAuthorizedRequest(mkReq('Bearer x'), SECRET));
        assert.equal(isAuthorizedRequest(mkReq('Bearer x'), SECRET), false);
    });
});

describe('EXAMPLE_SECRET_DENYLIST', () => {
    it('matches both documented example secrets case-insensitively', () => {
        assert.deepEqual(EXAMPLE_SECRET_DENYLIST, [
            'change-me-generate-with-openssl-rand-hex-32',
            'changeme-changeme-changeme',
        ]);
        assert.equal(isExampleSecret(DENY_A), true);
        assert.equal(isExampleSecret(DENY_A.toUpperCase()), true);
         assert.equal(isExampleSecret(DENY_B), true);
         assert.equal(isExampleSecret(DENY_B.toUpperCase()), true);
         assert.equal(isExampleSecret(`  ${DENY_A.toUpperCase()}  `), true);
         assert.equal(isExampleSecret('  changeme-changeme-changeme  '), true);
         assert.equal(isExampleSecret(SECRET), false);
     });
 });

describe('createExternalIngestRouter', () => {
    beforeEach(() => {
        const logger = logInstances['external-ingest'];
        if (logger) logger.entries.length = 0;
    });

    it('returns 404 when external ingest is disabled', async () => {
        const router = createExternalIngestRouter({
            config: { externalIngestEnabled: false, externalIngestSecret: SECRET },
            handlers: {},
        });
        const res = mkRes();
        await router.middlewares[0](mkReq(`Bearer ${SECRET}`), res, () => {
            assert.fail('disabled gate must not call next');
        });
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { error: 'Not found' });
    });

    it('returns 503 when the configured secret is too short', async () => {
        const router = createExternalIngestRouter({
            config: { externalIngestEnabled: true, externalIngestSecret: 'short' },
            handlers: {},
        });
        const res = mkRes();
        await router.middlewares[0](mkReq('Bearer short-but-presented'), res, () => {});
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'External ingest unavailable' });
    });

    it('returns 503 when the configured secret is denylisted', async () => {
        const router = createExternalIngestRouter({
            config: { externalIngestEnabled: true, externalIngestSecret: DENY_A },
            handlers: {},
        });
        const res = mkRes();
        await router.middlewares[0](mkReq(`Bearer ${DENY_A}`), res, () => {});
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'External ingest unavailable' });
    });

    it('returns 503 when the configured secret is a padded denylist entry', async () => {
        const router = createExternalIngestRouter({
            config: {
                externalIngestEnabled: true,
                externalIngestSecret: '  CHANGE-ME-GENERATE-WITH-OPENSSL-RAND-HEX-32  ',
            },
            handlers: {},
        });
        const res = mkRes();
        await router.middlewares[0](mkReq(`Bearer ${SECRET}`), res, () => {
            assert.fail('padded denylist secret must not call next');
        });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'External ingest unavailable' });
    });

    it('returns 503 when the presented bearer is denylisted, including case variants', async () => {
        const router = enabledRouter();
        const lower = await runRoute(router, 'POST /start', mkReq(`Bearer ${DENY_B}`, { body: { broadcastId: 'ok-id' } }));
        assert.equal(lower.statusCode, 503);
        assert.deepEqual(lower.body, { error: 'External ingest unavailable' });

        const upper = await runRoute(
            router,
            'POST /start',
            mkReq(`Bearer ${DENY_A.toUpperCase()}`, { body: { broadcastId: 'ok-id' } })
        );
        assert.equal(upper.statusCode, 503);
        assert.deepEqual(upper.body, { error: 'External ingest unavailable' });
    });

    it('returns 503 when the presented bearer is a padded denylist entry', async () => {
        const res = await runRoute(
            enabledRouter(),
            'POST /start',
            mkReq('Bearer   CHANGE-ME-GENERATE-WITH-OPENSSL-RAND-HEX-32  ', { body: { broadcastId: 'ok-id' } })
        );
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.body, { error: 'External ingest unavailable' });
    });

    it('returns 401 for a wrong bearer token', async () => {
        const res = await runRoute(
            enabledRouter(),
            'POST /start',
            mkReq('Bearer wrong-secret-1234567890', { body: { broadcastId: 'ok-id' } })
        );
        assert.equal(res.statusCode, 401);
        assert.deepEqual(res.body, { error: 'Unauthorized' });
    });

    it('returns 200 with the start contract shape', async () => {
        const res = await runRoute(
            enabledRouter(),
            'POST /start',
            mkReq(`Bearer ${SECRET}`, { body: { broadcastId: 'route-room', extra: 'ignored' } })
        );
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.broadcastId, 'route-room');
        assert.deepEqual(Object.keys(res.body).sort(), ['audio', 'broadcastId', 'video']);
        for (const kind of ['video', 'audio']) {
            assert.deepEqual(Object.keys(res.body[kind]).sort(), ['payloadType', 'port', 'profile', 'rtcpPort', 'ssrc']);
        }
        assert.equal(res.body.video.rtcpPort, null);
        assert.equal(res.body.video.payloadType, 104);
        assert.equal(res.body.audio.payloadType, 100);
    });

    it('maps handler error.status=409 to HTTP 409', async () => {
        const router = enabledRouter({
            createExternalIngest: async () => {
                const err = new Error('Room already has a browser broadcaster, external ingest is exclusive');
                err.status = 409;
                throw err;
            },
        });
        const res = await runRoute(router, 'POST /start', mkReq(`Bearer ${SECRET}`, { body: { broadcastId: 'conflict' } }));
        assert.equal(res.statusCode, 409);
        assert.deepEqual(res.body, { error: 'Room already has a browser broadcaster' });
    });

    it('maps handler throws to HTTP 502 without leaking internals', async () => {
        const router = enabledRouter({
            createExternalIngest: async () => {
                throw new Error('mediasoup blew up with internal detail');
            },
        });
        const res = await runRoute(router, 'POST /start', mkReq(`Bearer ${SECRET}`, { body: { broadcastId: 'x' } }));
        assert.equal(res.statusCode, 502);
        assert.deepEqual(res.body, { error: 'Failed to start external ingest' });
        assert.equal(JSON.stringify(res.body).includes('internal detail'), false);
    });

    it('returns 200 {stopped:true,broadcastId} on stop', async () => {
        const res = await runRoute(
            enabledRouter(),
            'POST /stop',
            mkReq(`Bearer ${SECRET}`, { path: '/stop', body: { broadcastId: 'route-room' } })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { stopped: true, broadcastId: 'route-room' });
    });

    it('returns 200 {ingests:[...]} on status', async () => {
        const res = await runRoute(enabledRouter(), 'GET /status', mkReq(`Bearer ${SECRET}`, { path: '/status' }));
        assert.equal(res.statusCode, 200);
        assert.ok(Array.isArray(res.body.ingests));
        assert.equal(res.body.ingests[0].broadcastId, 'room1');
    });

    it('returns 400 for a missing body or invalid broadcastId', async () => {
        const router = enabledRouter();
        const noBody = await runRoute(router, 'POST /start', mkReq(`Bearer ${SECRET}`, { body: undefined }));
        assert.equal(noBody.statusCode, 400);

        const traversal = await runRoute(
            router,
            'POST /start',
            mkReq(`Bearer ${SECRET}`, { body: { broadcastId: '../etc/passwd' } })
        );
        assert.equal(traversal.statusCode, 400);
        assert.deepEqual(traversal.body, { error: 'Invalid broadcastId' });
    });

    it('does not write secrets or tokens into captured log output', async () => {
        const router = enabledRouter();
        await runRoute(router, 'POST /start', mkReq(`Bearer ${SECRET}`, { body: { broadcastId: 'log-room' } }));
        await runRoute(router, 'POST /start', mkReq('Bearer wrong-secret-1234567890', { body: { broadcastId: 'log-room' } }));
        await runRoute(router, 'POST /start', mkReq(`Bearer ${DENY_A}`, { body: { broadcastId: 'log-room' } }));

        const text = loggedText();
        assert.equal(text.includes(SECRET), false);
        assert.equal(text.includes('wrong-secret-1234567890'), false);
        assert.equal(text.includes(DENY_A), false);
        assert.equal(text.includes('Bearer '), false);
    });

    it('POST /authorize returns 200 {allowed:true} when the handler allows', async () => {
        const router = enabledRouter({
            authorizeIngest: async ({ broadcastId, token }) => {
                assert.equal(broadcastId, 'auth-room');
                assert.equal(token, 'fake-stream-key-for-authorize');
                return { allowed: true };
            },
        });
        const res = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, {
                path: '/authorize',
                body: { broadcastId: 'auth-room', token: 'fake-stream-key-for-authorize', extra: 'ignored' },
            })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { allowed: true });
    });

    it('POST /authorize returns 200 {allowed:false} when the handler denies', async () => {
        const router = enabledRouter({
            authorizeIngest: async () => ({ allowed: false }),
        });
        const res = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: 'nope' } })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { allowed: false });
    });

    it('POST /authorize fail-closes to 200 {allowed:false} when the handler throws', async () => {
        const router = enabledRouter({
            authorizeIngest: async () => {
                throw new Error('registry exploded with internal detail');
            },
        });
        const res = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: 'fake-key' } })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { allowed: false });
        assert.equal(JSON.stringify(res.body).includes('internal detail'), false);
    });

    it('POST /authorize fail-closes to 200 {allowed:false} when no handler is wired', async () => {
        const res = await runRoute(
            enabledRouter(),
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: 'fake-key' } })
        );
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { allowed: false });
    });

    it('POST /authorize returns 400 for invalid body shapes', async () => {
        const router = enabledRouter({ authorizeIngest: async () => ({ allowed: true }) });
        const noBody = await runRoute(router, 'POST /authorize', mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: undefined }));
        assert.equal(noBody.statusCode, 400);
        assert.deepEqual(noBody.body, { error: 'JSON body required' });

        const arrayBody = await runRoute(router, 'POST /authorize', mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: [] }));
        assert.equal(arrayBody.statusCode, 400);

        const badId = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: '../etc/passwd', token: 'x' } })
        );
        assert.equal(badId.statusCode, 400);
        assert.deepEqual(badId.body, { error: 'Invalid broadcastId' });

        const missingToken = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room' } })
        );
        assert.equal(missingToken.statusCode, 400);
        assert.deepEqual(missingToken.body, { error: 'Invalid token' });

        const emptyToken = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: '' } })
        );
        assert.equal(emptyToken.statusCode, 400);

        const overlong = await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: 'x'.repeat(4097) } })
        );
        assert.equal(overlong.statusCode, 400);
        assert.deepEqual(overlong.body, { error: 'Invalid token' });
    });

    it('POST /authorize returns 401 for a wrong bearer and 404 when disabled', async () => {
        const enabled = await runRoute(
            enabledRouter({ authorizeIngest: async () => ({ allowed: true }) }),
            'POST /authorize',
            mkReq('Bearer wrong-secret-1234567890', { path: '/authorize', body: { broadcastId: 'auth-room', token: 'x' } })
        );
        assert.equal(enabled.statusCode, 401);
        assert.deepEqual(enabled.body, { error: 'Unauthorized' });

        const disabled = createExternalIngestRouter({
            config: { externalIngestEnabled: false, externalIngestSecret: SECRET },
            handlers: { authorizeIngest: async () => ({ allowed: true }) },
        });
        const res = await runRoute(
            disabled,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token: 'x' } })
        );
        assert.equal(res.statusCode, 404);
        assert.deepEqual(res.body, { error: 'Not found' });
    });

    it('does not write authorize tokens into captured log output', async () => {
        const token = 'fake-authorize-token-must-not-leak';
        const router = enabledRouter({
            authorizeIngest: async () => {
                throw new Error('boom while authorizing');
            },
        });
        await runRoute(
            router,
            'POST /authorize',
            mkReq(`Bearer ${SECRET}`, { path: '/authorize', body: { broadcastId: 'auth-room', token } })
        );
        const text = loggedText();
        assert.equal(text.includes(token), false);
        assert.equal(text.includes(SECRET), false);
        assert.equal(text.includes('Bearer '), false);
    });
});

describe('server.js authorizeIngest wiring (structural)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');

    it('injects authorizeIngest against the rooms registry (not loadable without runtime deps)', () => {
        // The router accepts an injected authorizeIngest handler; server.js is not
        // unit-loadable (httpolyglot/sentry/mediasoup). Guard the production wiring shape.
        assert.match(source, /authorizeIngest:\s*\(\{\s*broadcastId,\s*token\s*\}\)\s*=>/);
        assert.match(source, /roomRegistry\.getRoom\(broadcastId\)/);
        assert.match(source, /roomRegistry\.validateRtmpKey\(broadcastId,\s*token\)/);
        assert.match(source, /roomRegistry\.touch\(broadcastId\)/);
        assert.match(source, /requireRoom:\s*rtmpRequireRoom/);
        assert.match(source, /roomRegistry:\s*roomRegistry/);
        assert.match(source, /sourceType === 'rtmp'/);
    });
});
