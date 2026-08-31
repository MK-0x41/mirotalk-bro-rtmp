'use strict';

/**
 * Structural guard for the JSON-parse-error middleware redaction in app/server.js.
 *
 * server.js is not directly loadable without its runtime deps (httpolyglot, sentry,
 * mediasoup, …), and sanitizeHeaders is not exported from app/external-ingest.js
 * (the helper lives inline in server.js). This test reads the source and asserts
 * that the redaction list and '[REDACTED]' replacement exist.
 *
 * This is a structural guard, not a behavior test.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('server.js JSON-parse-error header redaction (structural guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');

    it('defines SENSITIVE_HEADERS and sanitizeHeaders that replace values with [REDACTED]', () => {
        assert.match(source, /const SENSITIVE_HEADERS = new Set\(\[/);
        assert.match(source, /'authorization'/);
        assert.match(source, /'cookie'/);
        assert.match(source, /'x-api-key'/);
        assert.match(source, /'proxy-authorization'/);
        assert.match(source, /function sanitizeHeaders\(headers\)/);
        assert.match(source, /safeHeaders\[name\] = '\[REDACTED\]'/);
        assert.match(source, /header: sanitizeHeaders\(req\.headers\)/);
    });

    it('uses sanitizeHeaders at both join-debug log sites, never raw req.headers', () => {
        const joinUnauthorized = source.match(
            /log\.debug\('MiroTalk get join - Unauthorized',\s*\{[\s\S]*?\}\s*\)/
        );
        const joinAuthorized = source.match(/log\.debug\('MiroTalk get join - Authorized',\s*\{[\s\S]*?\}\s*\)/);
        assert.ok(joinUnauthorized, 'expected MiroTalk get join - Unauthorized log site');
        assert.ok(joinAuthorized, 'expected MiroTalk get join - Authorized log site');

        const sanitizedForm = /header:\s*sanitizeHeaders\(req\.headers\)/;
        assert.match(joinUnauthorized[0], sanitizedForm);
        assert.match(joinAuthorized[0], sanitizedForm);

        const sanitizedInJoin = [
            ...(joinUnauthorized[0].match(/header:\s*sanitizeHeaders\(req\.headers\)/g) || []),
            ...(joinAuthorized[0].match(/header:\s*sanitizeHeaders\(req\.headers\)/g) || []),
        ];
        assert.equal(
            sanitizedInJoin.length,
            2,
            `expected header: sanitizeHeaders(req.headers) at both join-debug sites, got ${sanitizedInJoin.length}`
        );

        // Old leak: `header: req.headers` logged Authorization / cookies in cleartext.
        // sanitizeHeaders(req.headers) must not match this (no `header: req.headers` substring).
        assert.doesNotMatch(source, /header:\s*req\.headers/);
    });
});

/**
 * Structural guard for the E2E-found leak (apiKeySecret, OIDC clientSecret, SESSION_SECRET).
 *
 * Both `log.info('Server is running', …)` sites used to log apiKeySecret and the
 * raw OIDC config (clientSecret + session secret) in cleartext. The source must
 * keep the full masked `apiKeySecret: apiKeySecret ? 'set' : 'unset'` form and
 * `oidc: oidcLogSafe` instead of the raw `OIDC` object.
 */
describe('server.js startup log secret masking (structural guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');

    it('has two Server is running log sites, both masking apiKeySecret as set/unset', () => {
        const sites = source.match(/log\.info\('Server is running'/g);
        assert.equal(sites && sites.length, 2, `expected 2 Server is running log sites, got ${sites && sites.length}`);

        const masked = source.match(/apiKeySecret:\s*apiKeySecret\s*\?\s*'set'\s*:\s*'unset'/g);
        assert.equal(
            masked && masked.length,
            2,
            `expected apiKeySecret: apiKeySecret ? 'set' : 'unset' at both Server is running sites, got ${masked && masked.length}`
        );

        // Old leak: `apiKeySecret: apiKeySecret,` logged the secret in cleartext.
        assert.doesNotMatch(source, /apiKeySecret:\s*apiKeySecret\s*,/);
        // Partial mask `apiKeySecret ? apiKeySecret : 'unset'` would still leak the secret.
        assert.doesNotMatch(source, /apiKeySecret\s*\?\s*apiKeySecret\s*:/);
    });

    it('uses oidcLogSafe in both log objects instead of raw OIDC', () => {
        assert.match(source, /const oidcLogSafe\s*=\s*OIDC\.enabled/);
        assert.match(source, /clientSecret:\s*OIDC\.config\.clientSecret\s*\?\s*'set'\s*:\s*'unset'/);
        assert.match(source, /secret:\s*OIDC\.config\.secret\s*\?\s*'set'\s*:\s*'unset'/);

        const uses = source.match(/oidc:\s*oidcLogSafe/g);
        assert.equal(
            uses && uses.length,
            2,
            `expected oidc: oidcLogSafe in both Server is running log objects, got ${uses && uses.length}`
        );

        // Old leak: `oidc: OIDC.enabled ? OIDC : false` logged clientSecret + SESSION_SECRET.
        assert.doesNotMatch(source, /oidc:\s*OIDC\.enabled\s*\?\s*OIDC\b/);
        assert.doesNotMatch(source, /oidc:\s*OIDC\s*,/);
    });

    it('defines iceServersLogSafe that reduces credential-bearing entries to urls-only', () => {
        assert.match(source, /const iceServersLogSafe\s*=\s*iceServers\.map\(/);
        // Mapping pattern: username/credential present → log `{ urls }` only.
        assert.match(
            source,
            /server\.username\s*\|\|\s*server\.credential\s*\?\s*\{\s*urls:\s*server\.urls\s*\}/
        );
    });

    it('uses iceServersLogSafe in both Server is running log objects instead of raw iceServers', () => {
        const uses = source.match(/iceServers:\s*iceServersLogSafe/g);
        assert.equal(
            uses && uses.length,
            2,
            `expected iceServers: iceServersLogSafe in both Server is running log objects, got ${uses && uses.length}`
        );

        // Old leak: `iceServers: iceServers` logged TURN username/credential.
        // Do not match `iceServers: iceServersLogSafe` or the `const iceServers = []` construction.
        const rawLogged = source.match(/iceServers:\s*iceServers(?![A-Za-z0-9_])/g);
        assert.equal(
            rawLogged,
            null,
            `expected zero iceServers: iceServers log properties, got ${rawLogged && rawLogged.length}`
        );
    });
});

/**
 * Structural + extracted-function guard for sanitizeBody.
 *
 * server.js starts the HTTP server on require (httpolyglot/sentry/mediasoup),
 * so the helper is extracted from source rather than loaded as a module.
 * The extraction must match the production function body; log-site wiring
 * stays a structural assertion like sanitizeHeaders.
 */
describe('server.js sanitizeBody (structural + extracted helper)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');

    function loadSanitizeBody() {
        const reMatch = source.match(/const SENSITIVE_BODY_KEYS_RE = (\/token\|secret\|password\|streamkey\|key\|authorization\/i);/);
        assert.ok(reMatch, 'expected SENSITIVE_BODY_KEYS_RE');
        const fnMatch = source.match(/function sanitizeBody\(body\) \{[\s\S]*?return safeBody;\n\}/);
        assert.ok(fnMatch, 'expected sanitizeBody function');
        return new Function(`${reMatch[0]}\n${fnMatch[0]}\nreturn sanitizeBody;`)();
    }

    it('defines SENSITIVE_BODY_KEYS_RE, copies the object, and exports sanitizeBody', () => {
        assert.match(source, /const SENSITIVE_BODY_KEYS_RE = \/token\|secret\|password\|streamkey\|key\|authorization\/i/);
        assert.match(source, /function sanitizeBody\(body\)/);
        assert.match(source, /const safeBody = \{ \.\.\.body \}/);
        assert.match(source, /safeBody\[name\] = '\[REDACTED\]'/);
        assert.match(source, /return typeof body/);
        assert.match(source, /module\.exports = \{ sanitizeHeaders, sanitizeBody \}/);
        assert.match(source, /body: sanitizeBody\(req\.body\)/);
    });

    it('redacts token/TOKEN/mySecret/password/streamKey/apiKey/authorization without mutating the original', () => {
        const sanitizeBody = loadSanitizeBody();
        const original = {
            token: 'plain-token',
            TOKEN: 'UPPER-TOKEN',
            mySecret: 's3cret',
            password: 'hunter2',
            streamKey: 'sk-live',
            apiKey: 'ak-live',
            authorization: 'Bearer abc',
            name: 'studio',
            sourceType: 'rtmp',
        };
        const snapshot = { ...original };
        const redacted = sanitizeBody(original);

        assert.equal(redacted.token, '[REDACTED]');
        assert.equal(redacted.TOKEN, '[REDACTED]');
        assert.equal(redacted.mySecret, '[REDACTED]');
        assert.equal(redacted.password, '[REDACTED]');
        assert.equal(redacted.streamKey, '[REDACTED]');
        assert.equal(redacted.apiKey, '[REDACTED]');
        assert.equal(redacted.authorization, '[REDACTED]');
        assert.equal(redacted.name, 'studio');
        assert.equal(redacted.sourceType, 'rtmp');
        assert.deepEqual(original, snapshot);
        assert.notEqual(redacted, original);
    });

    it('returns typeof string for non-object bodies', () => {
        const sanitizeBody = loadSanitizeBody();
        assert.equal(sanitizeBody('plaintext'), 'string');
        assert.equal(sanitizeBody(null), 'object');
        assert.equal(sanitizeBody(undefined), 'undefined');
        assert.equal(sanitizeBody(12), 'number');
        assert.equal(sanitizeBody(['token']), 'object');
    });
});

/**
 * Structural guard: authorizeIngest must always call validateRtmpKey
 * before combining the boolean (no early-return / short-circuit before the
 * hash comparison — timing-oracle avoidance).
 */
describe('server.js authorizeIngest unconditional validateRtmpKey (structural guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../app/server.js'), 'utf8');

    it('calls validateRtmpKey before combining allowed, with no early return', () => {
        const handler = source.match(
            /authorizeIngest:\s*\(\{\s*broadcastId,\s*token\s*\}\)\s*=>\s*\{[\s\S]*?return \{ allowed \};/
        );
        assert.ok(handler, 'expected authorizeIngest arrow handler in server.js wiring');
        const body = handler[0];

        assert.match(body, /const room = roomRegistry\.getRoom\(broadcastId\)/);
        assert.match(body, /const keyValid = roomRegistry\.validateRtmpKey\(broadcastId,\s*token\)/);
        assert.match(body, /const allowed = Boolean\(room && room\.sourceType === 'rtmp' && keyValid\)/);

        const getRoomIdx = body.indexOf('roomRegistry.getRoom(broadcastId)');
        const validateIdx = body.indexOf('roomRegistry.validateRtmpKey(broadcastId, token)');
        const allowedIdx = body.indexOf('const allowed');
        assert.ok(getRoomIdx !== -1 && validateIdx !== -1 && allowedIdx !== -1);
        assert.ok(validateIdx < allowedIdx, 'validateRtmpKey must run before combining the boolean');

        assert.doesNotMatch(body, /if\s*\(\s*!room/);
        assert.doesNotMatch(body, /if\s*\(\s*room\s*===/);
        assert.doesNotMatch(body, /return\s+\{\s*allowed:\s*false/);
        assert.doesNotMatch(body, /return\s+false/);
        // Short-circuit of validateRtmpKey itself must not appear (e.g. room && validate...).
        assert.doesNotMatch(body, /&&\s*roomRegistry\.validateRtmpKey/);
        assert.doesNotMatch(body, /room\s*&&\s*roomRegistry\.validateRtmpKey/);
    });
});
