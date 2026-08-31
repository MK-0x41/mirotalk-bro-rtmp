'use strict';

/**
 * Integration-lite HTTP tests for createHttpServer + createAuthHandler.
 * Binds 127.0.0.1 on an ephemeral port. No mediamtx, no ffmpeg, no Docker.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { KeyStore } = require('../src/keys');
const { RateLimiter, createAuthHandler } = require('../src/auth');
const { createHttpServer } = require('../src/server');
const { createLogger } = require('../src/log');

const STREAM_KEY = 'fake-stream-key-for-http-tests-only';
const STREAM_HASH = crypto.createHash('sha256').update(STREAM_KEY, 'utf8').digest('hex');
const FOREIGN_IP = '203.0.113.50';

function silentLog() {
    return { error() {}, warn() {}, info() {}, debug() {} };
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(server.address().port);
        });
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
    });
}

async function postAuth(port, body) {
    const res = await fetch(`http://127.0.0.1:${port}/auth/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
}

describe('createHttpServer', () => {
    let dir;
    let keysFile;
    let server;
    let port;
    let captured = [];
    let stdoutWrite;

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmp-adapter-server-'));
        keysFile = path.join(dir, 'keys.json');
        fs.writeFileSync(keysFile, JSON.stringify({ streams: { room1: { keyHash: STREAM_HASH } } }));

        const keyStore = new KeyStore(keysFile, silentLog());
        assert.equal(keyStore.load(), true);

        const rateLimiter = new RateLimiter({ windowMs: 60_000, maxAttempts: 3 });
        const localIps = new Set(['127.0.0.1', '::1']);
        const log = createLogger('info');
        const handleAuth = createAuthHandler({ keyStore, localIps, rateLimiter, log });

        server = createHttpServer({
            log,
            handleAuth,
            getStatus: () => ({ activeIngests: 0, mediamtxReachable: false, broReachable: false }),
        });
        port = await listen(server);

        stdoutWrite = process.stdout.write.bind(process.stdout);
        process.stdout.write = (chunk, encoding, cb) => {
            const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
            captured.push(text);
            // Swallow JSON-lines adapter logs so they do not pollute TAP; still
            // captured above for the redaction assertion.
            if (text.startsWith('{') && text.includes('"msg"')) {
                if (typeof cb === 'function') cb();
                return true;
            }
            return stdoutWrite(chunk, encoding, cb);
        };
    });

    after(async () => {
        if (stdoutWrite) process.stdout.write = stdoutWrite;
        if (server) await closeServer(server);
        if (dir) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('POST /auth/publish allows a valid token+path with 200', async () => {
        const { status, json } = await postAuth(port, {
            ip: FOREIGN_IP,
            action: 'publish',
            path: 'live/room1',
            protocol: 'rtmp',
            token: STREAM_KEY,
            query: '',
            password: 'should-never-be-logged',
        });
        assert.equal(status, 200);
        assert.deepEqual(json, {});
    });

    it('POST /auth/publish denies a wrong token with 401', async () => {
        const { status, json } = await postAuth(port, {
            ip: '203.0.113.51',
            action: 'publish',
            path: 'live/room1',
            protocol: 'rtmp',
            token: 'wrong-token',
            query: `token=${STREAM_KEY}`,
        });
        // body.token is non-empty so the query fallback is not used; wrong token → 401
        assert.equal(status, 401);
        assert.equal(json.error, 'unauthorized');
    });

    it('POST /auth/publish rate-limits with 429 after the failure threshold', async () => {
        const ip = '203.0.113.52';
        for (let i = 0; i < 3; i += 1) {
            const { status } = await postAuth(port, {
                ip,
                action: 'publish',
                path: 'live/room1',
                protocol: 'rtmp',
                token: 'bad',
            });
            assert.equal(status, 401);
        }
        const blocked = await postAuth(port, {
            ip,
            action: 'publish',
            path: 'live/room1',
            protocol: 'rtmp',
            token: STREAM_KEY,
        });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.json.error, 'too many requests');
    });

    it('POST /auth/publish denies action=read from a foreign IP with 401', async () => {
        const { status, json } = await postAuth(port, {
            ip: FOREIGN_IP,
            action: 'read',
            path: 'live/room1',
            protocol: 'rtmp',
            token: STREAM_KEY,
        });
        assert.equal(status, 401);
        assert.equal(json.error, 'unauthorized');
    });

    it('GET /healthz returns 200 with expected fields', async () => {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        const json = await res.json();
        assert.deepEqual(json, {
            ok: true,
            activeIngests: 0,
            mediamtxReachable: false,
            broReachable: false,
        });
    });

    it('returns 404 for unknown routes and 400 for invalid JSON', async () => {
        const missing = await fetch(`http://127.0.0.1:${port}/nope`);
        assert.equal(missing.status, 404);

        const bad = await fetch(`http://127.0.0.1:${port}/auth/publish`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{not json',
        });
        assert.equal(bad.status, 400);
    });

    it('does not write tokens, passwords or query strings to stdout logs', () => {
        const output = captured.join('');
        assert.equal(output.includes(STREAM_KEY), false);
        assert.equal(output.includes('should-never-be-logged'), false);
        assert.equal(output.includes(`token=${STREAM_KEY}`), false);
        assert.equal(output.includes(STREAM_HASH), false);
    });
});

// SIGTERM / graceful shutdown lives in src/index.js (side-effectful main() that
// calls process.exit). createHttpServer does not register signal handlers, so
// that path is not unit-testable without spawning the process. Covered by the
// Vagrant E2E runbook.
