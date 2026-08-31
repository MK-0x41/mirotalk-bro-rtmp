'use strict';

/**
 * Unit tests for config.js validation seams. No process.env mutation.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig, ConfigError, EXAMPLE_SECRET_DENYLIST } = require('../src/config');

function baseEnv(overrides = {}) {
    return {
        BRO_INGEST_SECRET: 'fake-unit-test-secret-16',
        BRO_BASE_URL: 'http://bro.example',
        MEDIAMTX_API_BASE: 'http://mediamtx.example:9997',
        MEDIAMTX_RTMP_SOURCE: 'rtmp://mediamtx:19350',
        ...overrides,
    };
}

describe('EXAMPLE_SECRET_DENYLIST', () => {
    it('exports both documented example secrets', () => {
        assert.deepEqual(EXAMPLE_SECRET_DENYLIST, [
            'change-me-generate-with-openssl-rand-hex-32',
            'changeme-changeme-changeme',
        ]);
    });

    it('rejects both denylist entries case-insensitively', () => {
        const variants = [
            'change-me-generate-with-openssl-rand-hex-32',
            'CHANGE-ME-GENERATE-WITH-OPENSSL-RAND-HEX-32',
            'Change-Me-Generate-With-Openssl-Rand-Hex-32',
            'changeme-changeme-changeme',
            'CHANGEME-CHANGEME-CHANGEME',
            'ChangeMe-ChangeMe-ChangeMe',
        ];
        for (const secret of variants) {
            assert.throws(() => loadConfig(baseEnv({ BRO_INGEST_SECRET: secret })), (err) => {
                assert.equal(err.name, 'ConfigError');
                assert.match(err.message, /known example value/);
                return true;
            });
        }
        assert.doesNotThrow(() => loadConfig(baseEnv()));
    });

    it('rejects a padded denylist entry', () => {
        assert.throws(
            () => loadConfig(baseEnv({ BRO_INGEST_SECRET: '  CHANGE-ME-GENERATE-WITH-OPENSSL-RAND-HEX-32  ' })),
            (err) => {
                assert.equal(err.name, 'ConfigError');
                assert.match(err.message, /known example value/);
                return true;
            }
        );
    });
});

describe('MAX_CONCURRENT_INGESTS', () => {
    it('defaults to 4 when unset', () => {
        const config = loadConfig(baseEnv());
        assert.equal(config.maxConcurrentIngests, 4);
    });

    it('rejects 0, -1 and non-integers', () => {
        for (const value of ['0', '-1', 'abc']) {
            assert.throws(() => loadConfig(baseEnv({ MAX_CONCURRENT_INGESTS: value })), (err) => {
                assert.equal(err.name, ConfigError.name);
                assert.match(err.message, /MAX_CONCURRENT_INGESTS must be an integer >= 1/);
                return true;
            });
        }
    });
});
