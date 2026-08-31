'use strict';

// Quellen-Registry: Räume mit gewählter Quelle (camera|screen|rtmp).
// Bewusst In-Memory wie das Raumkonzept des Upstreams (keine Persistenz im
// Betrieb); das Storage-Interface ist so geschnitten, dass später ein
// SQLite-Backend (node:sqlite) ohne Umbau der Aufrufer einklinken kann.

const crypto = require('crypto');

const SOURCE_TYPES = ['camera', 'screen', 'rtmp'];
const MAX_NAME_LENGTH = 128;
const DEFAULT_MAX_RTMP_ROOMS = 50;
const MAX_TOKEN_LENGTH = 4096;

// Steuerzeichen (C0/C1) werden aus Namen entfernt, bevor validiert wird.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;

// Fixed 32-byte dummy comparison target (all zeros, never a sha256 output).
const DUMMY_HASH_BUFFER = Buffer.alloc(32);

/**
 * Registry-Fehler mit maschinenlesbarem Code und sicherer Nachricht
 * (enthält niemals Schlüsselmaterial oder Nutzereingaben).
 */
class RoomError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'RoomError';
        this.code = code;
    }
}

/**
 * Raumnamen bereinigen: Steuerzeichen entfernen, Whitespace trimmen, danach
 * Länge 1-128 prüfen. Gibt null zurück, wenn kein gültiger Name übrig bleibt.
 */
function sanitizeRoomName(name) {
    if (typeof name !== 'string') return null;
    const stripped = name.replace(CONTROL_CHARS_RE, '').trim();
    if (stripped.length < 1 || stripped.length > MAX_NAME_LENGTH) return null;
    return stripped;
}

/**
 * Fabrik für die Raum-Registry.
 *
 * @param {object} [options]
 * @param {number} [options.maxRtmpRooms=50] Obergrenze gleichzeitig
 *   registrierter RTMP-Räume (createRoom darüber wirft RTMP_ROOMS_FULL).
 * @returns {object} Registry-Interface (createRoom, getRoom, listRooms,
 *   deleteRoom, rotateKey, setKey, validateRtmpKey, touch, activeRtmpCount)
 */
function createRoomRegistry({ maxRtmpRooms } = {}) {
    const roomCap =
        Number.isInteger(maxRtmpRooms) && maxRtmpRooms > 0 ? maxRtmpRooms : DEFAULT_MAX_RTMP_ROOMS;

    /** @type {Map<string, object>} id -> Raum-Record (ohne Schlüsselmaterial) */
    const rooms = new Map();
    /** @type {Map<string, string>} id -> sha256 hex Hash des Stream-Keys */
    const rtmpKeyHashes = new Map();

    /**
     * Neuen Stream-Key erzeugen: 32 Zufallsbytes als Hex. Gespeichert wird
     * NUR der sha256-Hash; der Klartext wird genau einmal an den Aufrufer
     * zurückgegeben (create/rotate der Admin-API) und niemals persistiert.
     */
    function issueKey(id) {
        const key = crypto.randomBytes(32).toString('hex');
        rtmpKeyHashes.set(id, crypto.createHash('sha256').update(key, 'utf8').digest('hex'));
        return key;
    }

    function createRoom({ name, sourceType } = {}) {
        if (!SOURCE_TYPES.includes(sourceType)) {
            throw new RoomError('INVALID_SOURCE', 'Invalid source type');
        }
        const cleanName = sanitizeRoomName(name);
        if (!cleanName) {
            throw new RoomError('INVALID_NAME', 'Invalid room name');
        }
        if (sourceType === 'rtmp' && activeRtmpCount() >= roomCap) {
            throw new RoomError('RTMP_ROOMS_FULL', 'Too many active RTMP rooms');
        }
        const createdAt = new Date().toISOString();
        const room = {
            id: crypto.randomUUID(),
            name: cleanName,
            sourceType,
            createdAt,
            lastUsedAt: createdAt,
            rtmp: null, // Platzhalter für späteren RTMP-Zustand; nie Schlüsselmaterial
        };
        rooms.set(room.id, room);
        // Klartext-Key genau EINMAL beim Erzeugen ausgeben (nur rtmp-Räume);
        // die Registry speichert ausschließlich den sha256-Hash. Aufrufer
        // (rooms-routes) dürfen setKey dafür nicht erneut aufrufen.
        const key = sourceType === 'rtmp' ? issueKey(room.id) : null;
        return { room, key };
    }

    function getRoom(id) {
        return rooms.get(id) || null;
    }

    function listRooms() {
        return [...rooms.values()];
    }

    function deleteRoom(id) {
        rtmpKeyHashes.delete(id);
        return rooms.delete(id);
    }

    function requireRoom(id) {
        const room = rooms.get(id);
        if (!room) throw new RoomError('NOT_FOUND', 'Room not found');
        return room;
    }

    /** Neuen Stream-Key setzen; gibt den Klartext genau einmal zurück. */
    function setKey(id) {
        const room = requireRoom(id);
        if (room.sourceType !== 'rtmp') throw new RoomError('NOT_RTMP_ROOM', 'Room is not an RTMP room');
        return issueKey(id);
    }

    /** Wie setKey, semantisch als Rotation aus der Admin-API. */
    function rotateKey(id) {
        return setKey(id);
    }

    /**
     * Timing-sicherer Stream-Key-Check mit uniformer Laufzeit: der sha256-Hash
     * wird IMMER berechnet (auch wenn der Raum fehlt) und konstant-zeitlich
     * gegen den gespeicherten Hash bzw. einen festen 32-Byte-Dummy verglichen
     * (Spiegelung des Musters aus rtmp-adapter/src/auth.js).
     */
    function validateRtmpKey(id, token) {
        const tokenValid = typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH;
        const presented = crypto.createHash('sha256').update(tokenValid ? token : '', 'utf8').digest();
        let expected = DUMMY_HASH_BUFFER;
        const hash = typeof id === 'string' ? rtmpKeyHashes.get(id) : null;
        if (typeof hash === 'string') {
            const candidate = Buffer.from(hash, 'hex');
            if (candidate.length === presented.length) expected = candidate;
        }
        const matches = crypto.timingSafeEqual(presented, expected);
        return tokenValid && matches;
    }

    function touch(id) {
        const room = rooms.get(id);
        if (!room) return false;
        room.lastUsedAt = new Date().toISOString();
        return true;
    }

    function activeRtmpCount() {
        let count = 0;
        for (const room of rooms.values()) {
            if (room.sourceType === 'rtmp') count += 1;
        }
        return count;
    }

    return {
        createRoom,
        getRoom,
        listRooms,
        deleteRoom,
        rotateKey,
        setKey,
        validateRtmpKey,
        touch,
        activeRtmpCount,
    };
}

module.exports = {
    createRoomRegistry,
    RoomError,
    sanitizeRoomName,
    SOURCE_TYPES,
    MAX_NAME_LENGTH,
    DEFAULT_MAX_RTMP_ROOMS,
    MAX_TOKEN_LENGTH,
};
