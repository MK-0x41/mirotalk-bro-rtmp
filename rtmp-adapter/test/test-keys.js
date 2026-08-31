'use strict';

/**
 * Unit tests for keys.js: parseKeys (pure) and KeyStore last-valid load semantics.
 * Uses temp files; does not start fs.watchFile (KeyStore.start).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { parseKeys, KeyStore } = require('../src/keys');

function sha256hex(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

const HASH_A = sha256hex('fake-stream-key-a');
const HASH_B = sha256hex('fake-stream-key-b');

function silentLog() {
    return { error() {}, warn() {}, info() {}, debug() {} };
}

describe('parseKeys', () => {
    it('parses a valid file with two streams', () => {
        const parsed = parseKeys(
            JSON.stringify({
                _comment: 'ignored documentation field',
                streams: {
                    room1: { keyHash: HASH_A, extra: 'ignored' },
                    room_2: { keyHash: HASH_B },
                },
            })
        );
        assert.deepEqual(Object.assign({}, parsed.streams), {
            room1: { keyHash: HASH_A },
            room_2: { keyHash: HASH_B },
        });
    });

    it('accepts an empty streams object', () => {
        const parsed = parseKeys(JSON.stringify({ streams: {} }));
        assert.deepEqual(Object.assign({}, parsed.streams), {});
    });

    it('normalizes keyHash trim + uppercase hex to lowercase', () => {
        const parsed = parseKeys(
            JSON.stringify({
                streams: {
                    RoomId: { keyHash: `  ${HASH_A.toUpperCase()}  ` },
                },
            })
        );
        assert.equal(parsed.streams.RoomId.keyHash, HASH_A);
    });

    it('rejects malformed JSON', () => {
        assert.throws(() => parseKeys('{not json'), { message: /not valid JSON/ });
    });

    it('rejects a non-object top-level value', () => {
        assert.throws(() => parseKeys('[]'), { message: /JSON object/ });
        assert.throws(() => parseKeys('null'), { message: /JSON object/ });
        assert.throws(() => parseKeys('"nope"'), { message: /JSON object/ });
    });

    it('rejects missing or non-object streams', () => {
        assert.throws(() => parseKeys('{}'), { message: /"streams" object/ });
        assert.throws(() => parseKeys(JSON.stringify({ streams: null })), { message: /"streams" object/ });
        assert.throws(() => parseKeys(JSON.stringify({ streams: [] })), { message: /"streams" object/ });
        assert.throws(() => parseKeys(JSON.stringify({ streams: 'x' })), { message: /"streams" object/ });
    });

    it('rejects an invalid broadcastId', () => {
        assert.throws(
            () => parseKeys(JSON.stringify({ streams: { 'live/../escape': { keyHash: HASH_A } } })),
            { message: /invalid broadcastId/ }
        );
        assert.throws(
            () => parseKeys(JSON.stringify({ streams: { '': { keyHash: HASH_A } } })),
            { message: /invalid broadcastId/ }
        );
        assert.throws(
            () =>
                parseKeys(
                    JSON.stringify({
                        streams: { ['x'.repeat(129)]: { keyHash: HASH_A } },
                    })
                ),
            { message: /invalid broadcastId/ }
        );
    });

    it('rejects a non-object stream entry', () => {
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: null } })), {
            message: /must be an object/,
        });
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: [] } })), {
            message: /must be an object/,
        });
    });

    it('rejects keyHash that is not a 64-hex sha256', () => {
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: { keyHash: 1 } } })), {
            message: /keyHash must be a string/,
        });
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: { keyHash: 'abc' } } })), {
            message: /64 lowercase hex/,
        });
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: { keyHash: 'z'.repeat(64) } } })), {
            message: /64 lowercase hex/,
        });
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: { keyHash: 'a'.repeat(63) } } })), {
            message: /64 lowercase hex/,
        });
        assert.throws(() => parseKeys(JSON.stringify({ streams: { room1: { keyHash: 'a'.repeat(65) } } })), {
            message: /64 lowercase hex/,
        });
    });
});

describe('KeyStore.load last-valid semantics', () => {
    let dir;
    let file;

    before(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtmp-adapter-keys-'));
        file = path.join(dir, 'keys.json');
    });

    after(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('loads a valid file and looks up by broadcastId', () => {
        fs.writeFileSync(
            file,
            JSON.stringify({ streams: { room1: { keyHash: HASH_A }, room2: { keyHash: HASH_B } } })
        );
        const store = new KeyStore(file, silentLog());
        assert.equal(store.load(), true);
        assert.deepEqual(store.get('room1'), { keyHash: HASH_A });
        assert.deepEqual(store.get('room2'), { keyHash: HASH_B });
        assert.equal(store.get('missing'), null);
    });

    it('keeps last valid state when the file becomes malformed JSON', () => {
        fs.writeFileSync(file, JSON.stringify({ streams: { room1: { keyHash: HASH_A } } }));
        const store = new KeyStore(file, silentLog());
        assert.equal(store.load(), true);

        fs.writeFileSync(file, '{not-json');
        assert.equal(store.load(), false);
        assert.deepEqual(store.get('room1'), { keyHash: HASH_A });
    });

    it('keeps last valid state when streams has the wrong shape', () => {
        fs.writeFileSync(file, JSON.stringify({ streams: { room1: { keyHash: HASH_A } } }));
        const store = new KeyStore(file, silentLog());
        assert.equal(store.load(), true);

        fs.writeFileSync(file, JSON.stringify({ streams: ['nope'] }));
        assert.equal(store.load(), false);
        assert.deepEqual(store.get('room1'), { keyHash: HASH_A });
    });

    it('returns false and keeps empty state when the file is missing', () => {
        const missing = path.join(dir, 'does-not-exist.json');
        const store = new KeyStore(missing, silentLog());
        assert.equal(store.load(), false);
        assert.equal(store.get('room1'), null);
        assert.deepEqual(Object.assign({}, store.streams), {});
    });

    it('revokes all streams when a previously loaded file is deleted', () => {
        const ephemeral = path.join(dir, 'ephemeral.json');
        fs.writeFileSync(ephemeral, JSON.stringify({ streams: { room1: { keyHash: HASH_A } } }));
        const store = new KeyStore(ephemeral, silentLog());
        assert.equal(store.load(), true);
        assert.deepEqual(store.get('room1'), { keyHash: HASH_A });
        fs.unlinkSync(ephemeral);
        assert.equal(store.load(), false);
        assert.equal(store.get('room1'), null);
        assert.deepEqual(Object.assign({}, store.streams), {});
    });

    it('keeps last valid state when a previously loaded file becomes malformed JSON', () => {
        const ephemeral = path.join(dir, 'malformed-after-load.json');
        fs.writeFileSync(ephemeral, JSON.stringify({ streams: { room1: { keyHash: HASH_A } } }));
        const store = new KeyStore(ephemeral, silentLog());
        assert.equal(store.load(), true);
        fs.writeFileSync(ephemeral, '{not-json');
        assert.equal(store.load(), false);
        assert.deepEqual(store.get('room1'), { keyHash: HASH_A });
    });

    it('replaces state when a subsequent file is valid but empty (empty is not malformed)', () => {
        fs.writeFileSync(file, JSON.stringify({ streams: { room1: { keyHash: HASH_A } } }));
        const store = new KeyStore(file, silentLog());
        assert.equal(store.load(), true);
        fs.writeFileSync(file, JSON.stringify({ streams: {} }));
        assert.equal(store.load(), true);
        assert.equal(store.get('room1'), null);
    });
});
