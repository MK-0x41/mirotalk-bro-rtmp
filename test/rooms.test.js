'use strict';

/**
 * Unit tests for app/rooms.js (in-memory room registry).
 * Real module, no stubs, no network.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    createRoomRegistry,
    RoomError,
    sanitizeRoomName,
    SOURCE_TYPES,
    MAX_NAME_LENGTH,
} = require('../app/rooms');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const HEX_64_ANYWHERE = /[0-9a-f]{64}/i;

function assertRoomError(fn, code) {
    assert.throws(fn, (err) => {
        assert.equal(err instanceof RoomError, true);
        assert.equal(err.name, 'RoomError');
        assert.equal(err.code, code);
        return true;
    });
}

describe('createRoom shapes', () => {
    it('assigns a uuid v4 id and default record fields', () => {
        const registry = createRoomRegistry();
        const { room } = registry.createRoom({ name: 'Studio', sourceType: 'camera' });
        assert.match(room.id, UUID_V4);
        assert.equal(room.name, 'Studio');
        assert.equal(room.sourceType, 'camera');
        assert.equal(typeof room.createdAt, 'string');
        assert.equal(room.lastUsedAt, room.createdAt);
        assert.doesNotThrow(() => new Date(room.createdAt).toISOString());
        assert.equal(room.rtmp, null);
        assert.equal(registry.getRoom(room.id), room);
        assert.deepEqual(SOURCE_TYPES, ['camera', 'screen', 'rtmp']);
    });

    it('strips control characters from names before accepting them', () => {
        const registry = createRoomRegistry();
        const { room } = registry.createRoom({ name: 'hello\u0000world\n', sourceType: 'screen' });
        assert.equal(room.name, 'helloworld');
        assert.equal(sanitizeRoomName('  trimmed\u007F  '), 'trimmed');
        assert.equal(sanitizeRoomName('ok'), 'ok');
    });

    it('rejects empty, overlong, and non-string names', () => {
        const registry = createRoomRegistry();
        assertRoomError(() => registry.createRoom({ name: '', sourceType: 'camera' }), 'INVALID_NAME');
        assertRoomError(() => registry.createRoom({ name: '   ', sourceType: 'camera' }), 'INVALID_NAME');
        assertRoomError(() => registry.createRoom({ name: '\u0000\u0001', sourceType: 'camera' }), 'INVALID_NAME');
        assertRoomError(
            () => registry.createRoom({ name: 'x'.repeat(MAX_NAME_LENGTH + 1), sourceType: 'camera' }),
            'INVALID_NAME'
        );
        assertRoomError(() => registry.createRoom({ name: 12, sourceType: 'camera' }), 'INVALID_NAME');
        assertRoomError(() => registry.createRoom({ sourceType: 'camera' }), 'INVALID_NAME');
        const { room: ok } = registry.createRoom({ name: 'y'.repeat(MAX_NAME_LENGTH), sourceType: 'camera' });
        assert.equal(ok.name.length, MAX_NAME_LENGTH);
    });

    it('accepts only the sourceType whitelist', () => {
        const registry = createRoomRegistry();
        for (const sourceType of SOURCE_TYPES) {
            const { room } = registry.createRoom({ name: sourceType + '-room', sourceType });
            assert.equal(room.sourceType, sourceType);
        }
        assertRoomError(() => registry.createRoom({ name: 'bad', sourceType: 'obs' }), 'INVALID_SOURCE');
        assertRoomError(() => registry.createRoom({ name: 'bad', sourceType: 'RTMP' }), 'INVALID_SOURCE');
        assertRoomError(() => registry.createRoom({ name: 'bad' }), 'INVALID_SOURCE');
    });
});

describe('rtmp key material isolation', () => {
    it('stores a key hash internally but never serializes 64-hex material on the record', () => {
        const registry = createRoomRegistry();
        const { room, key } = registry.createRoom({ name: 'RTMP Studio', sourceType: 'rtmp' });
        assert.match(key, HEX_64);
        assert.equal(registry.validateRtmpKey(room.id, key), true);
        assert.equal(room.keyHash, undefined);
        assert.equal(room.streamKey, undefined);
        assert.equal(room.rtmp, null);
        const serialized = JSON.stringify(room);
        assert.equal(HEX_64_ANYWHERE.test(serialized), false);
        assert.equal(serialized.includes('keyHash'), false);
        assert.equal(serialized.includes(key), false);
        // A known plaintext obtained via setKey still must not leak onto the record.
        const rotated = registry.setKey(room.id);
        assert.match(rotated, HEX_64);
        assert.equal(HEX_64_ANYWHERE.test(JSON.stringify(room)), false);
        assert.equal(JSON.stringify(registry.getRoom(room.id)).includes(key), false);
        assert.equal(JSON.stringify(registry.getRoom(room.id)).includes(rotated), false);
    });
});

describe('createRoom key return', () => {
    it('returns a one-time 64-hex key only for rtmp rooms (camera/screen → null)', () => {
        const registry = createRoomRegistry();
        const camera = registry.createRoom({ name: 'Cam', sourceType: 'camera' });
        assert.equal(camera.key, null);
        assert.equal(HEX_64_ANYWHERE.test(JSON.stringify(camera.room)), false);

        const screen = registry.createRoom({ name: 'Screen', sourceType: 'screen' });
        assert.equal(screen.key, null);
        assert.equal(HEX_64_ANYWHERE.test(JSON.stringify(screen.room)), false);

        const rtmp = registry.createRoom({ name: 'Live', sourceType: 'rtmp' });
        assert.match(rtmp.key, HEX_64);
        assert.equal(registry.validateRtmpKey(rtmp.room.id, rtmp.key), true);
        assert.equal(HEX_64_ANYWHERE.test(JSON.stringify(rtmp.room)), false);
        assert.equal(JSON.stringify(rtmp.room).includes(rtmp.key), false);
        assert.equal(JSON.stringify(registry.getRoom(rtmp.room.id)).includes(rtmp.key), false);
    });
});

describe('validateRtmpKey', () => {
    it('accepts the correct key and rejects wrong, missing, and non-rtmp rooms', () => {
        const registry = createRoomRegistry();
        const { room: rtmp, key } = registry.createRoom({ name: 'Live', sourceType: 'rtmp' });
        const { room: camera } = registry.createRoom({ name: 'Cam', sourceType: 'camera' });
        assert.match(key, HEX_64);

        assert.equal(registry.validateRtmpKey(rtmp.id, key), true);
        assert.equal(registry.validateRtmpKey(rtmp.id, 'wrong-key-not-the-real-one'), false);
        assert.equal(registry.validateRtmpKey(rtmp.id, key + 'x'), false);
        assert.equal(registry.validateRtmpKey(rtmp.id, ''), false);
        assert.equal(registry.validateRtmpKey('00000000-0000-4000-8000-000000000000', key), false);
        assert.equal(registry.validateRtmpKey(camera.id, key), false);
        assert.equal(registry.validateRtmpKey(camera.id, 'anything'), false);
        assert.equal(registry.validateRtmpKey(null, key), false);
    });

    it('always hashes and compares (dummy buffer) even when the room is missing', () => {
        const source = fs.readFileSync(path.join(__dirname, '../app/rooms.js'), 'utf8');
        assert.match(source, /DUMMY_HASH_BUFFER = Buffer\.alloc\(32\)/);
        const fnStart = source.indexOf('function validateRtmpKey');
        const fnEnd = source.indexOf('function touch');
        assert.ok(fnStart !== -1 && fnEnd > fnStart);
        const body = source.slice(fnStart, fnEnd);
        assert.match(body, /crypto\.createHash\('sha256'\)\.update\(tokenValid \? token : '', 'utf8'\)\.digest\(\)/);
        assert.match(body, /let expected = DUMMY_HASH_BUFFER/);
        assert.match(body, /crypto\.timingSafeEqual\(presented, expected\)/);
        const hashIdx = body.indexOf("createHash('sha256')");
        const lookupIdx = body.indexOf('rtmpKeyHashes.get(id)');
        const compareIdx = body.indexOf('timingSafeEqual(presented, expected)');
        assert.ok(hashIdx !== -1 && lookupIdx !== -1 && compareIdx !== -1);
        assert.ok(hashIdx < lookupIdx, 'sha256 must run even when the room/hash lookup misses');
        assert.ok(lookupIdx < compareIdx, 'timingSafeEqual must run against dummy or stored hash');
    });
});

describe('rotateKey', () => {
    it('returns a new 64-hex plaintext, invalidates the old key, and accepts the new one', () => {
        const registry = createRoomRegistry();
        const { room, key: oldKey } = registry.createRoom({ name: 'Rotate', sourceType: 'rtmp' });
        assert.match(oldKey, HEX_64);
        const newKey = registry.rotateKey(room.id);
        assert.match(newKey, HEX_64);
        assert.notEqual(newKey, oldKey);
        assert.equal(registry.validateRtmpKey(room.id, oldKey), false);
        assert.equal(registry.validateRtmpKey(room.id, newKey), true);
        assert.equal(JSON.stringify(room).includes(newKey), false);
    });

    it('throws NOT_RTMP_ROOM for camera/screen rooms and NOT_FOUND when missing', () => {
        const registry = createRoomRegistry();
        const { room: camera } = registry.createRoom({ name: 'Cam', sourceType: 'camera' });
        assertRoomError(() => registry.rotateKey(camera.id), 'NOT_RTMP_ROOM');
        assertRoomError(() => registry.rotateKey('00000000-0000-4000-8000-000000000000'), 'NOT_FOUND');
    });
});

describe('deleteRoom, cap, touch', () => {
    it('deleteRoom removes the record and invalidates its stream key', () => {
        const registry = createRoomRegistry();
        const { room, key } = registry.createRoom({ name: 'Gone', sourceType: 'rtmp' });
        assert.match(key, HEX_64);
        assert.equal(registry.deleteRoom(room.id), true);
        assert.equal(registry.getRoom(room.id), null);
        assert.equal(registry.validateRtmpKey(room.id, key), false);
        assert.equal(registry.listRooms().length, 0);
        assert.equal(registry.deleteRoom(room.id), false);
    });

    it('enforces maxRtmpRooms=2 while leaving camera rooms unlimited', () => {
        const registry = createRoomRegistry({ maxRtmpRooms: 2 });
        registry.createRoom({ name: 'rtmp-1', sourceType: 'rtmp' });
        registry.createRoom({ name: 'rtmp-2', sourceType: 'rtmp' });
        assertRoomError(() => registry.createRoom({ name: 'rtmp-3', sourceType: 'rtmp' }), 'RTMP_ROOMS_FULL');
        for (let i = 0; i < 5; i += 1) {
            registry.createRoom({ name: 'cam-' + i, sourceType: 'camera' });
        }
        assert.equal(registry.activeRtmpCount(), 2);
        assert.equal(registry.listRooms().length, 7);
    });

    it('touch updates lastUsedAt and returns false for a missing room', () => {
        const registry = createRoomRegistry();
        const { room } = registry.createRoom({ name: 'Touch', sourceType: 'camera' });
        room.lastUsedAt = '2020-01-01T00:00:00.000Z';
        assert.equal(registry.touch(room.id), true);
        assert.notEqual(room.lastUsedAt, '2020-01-01T00:00:00.000Z');
        assert.match(room.lastUsedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.equal(registry.touch('00000000-0000-4000-8000-000000000000'), false);
    });
});
