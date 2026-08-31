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
});
