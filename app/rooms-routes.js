'use strict';

/**
 * MiroTalk BRO - Rooms API (Fork)
 *
 * Admin-geschützte REST-API über die Raum-Registry (camera|screen|rtmp):
 * Räume anlegen/auflisten/löschen und RTMP-Stream-Keys rotieren. Der
 * Stream-Key (Klartext) wird ausschließlich bei Erzeugung und Rotation
 * zurückgegeben; Listen/Get-Antworten enthalten niemals Schlüsselmaterial
 * (die Registry speichert ohnehin nur den sha256-Hash).
 *
 * Der Mountpunkt /api/v1/rooms ist öffentlich erreichbar und ausschließlich
 * durch den ADMIN_TOKEN geschützt (Bearer). Ohne konfiguriertes Token ist die
 * API bewusst unbenutzbar (503, fail-closed) — sie vergibt Stream-Keys.
 * Fehlgeschlagene Auth-Versuche werden zusätzlich pro IP ratenlimitiert
 * (AuthRateLimiter: 10 Fehlversuche/60s → 429, erfolgreiche Auth resetet).
 */

const crypto = require('crypto');
const express = require('express');

const logs = require('./logs');
const log = new logs('rooms');

const ROOM_ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_TOKEN_LENGTH = 4096;

// Rate-Limit der Auth-Middleware (Spiegelung des Adapter-Musters aus
// rtmp-adapter/src/auth.js): 10 fehlgeschlagene Auth-Versuche pro IP und
// 60s-Fenster → 429; erfolgreiche Auth setzt den Zähler zurück.
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_ATTEMPTS = 10;
// Hartes Limit getrackter IPs: bei Erreichen werden Einträge mit dem ältesten
// Fenster zuerst verdrängt, damit IP-Spoofing den Speicher nicht unbeschränkt
// wachsen lässt (Overlay-/X-Forwarded-Szenarien).
const RATE_LIMITER_MAX_ENTRIES = 10000;

// Dokumentierter Default-Wert aus .env.template: öffentlich bekannt und damit
// für diese API (sie vergibt Stream-Keys) niemals ein gültiges ADMIN_TOKEN.
const DEFAULT_ADMIN_TOKEN_DENYLIST = ['mirotalkbro_default_admin_token'];

function isValidRoomId(value) {
    return typeof value === 'string' && ROOM_ID_PATTERN.test(value);
}

/**
 * In-Memory Fixed-Window-Limiter für fehlgeschlagene Auth-Versuche pro IP.
 * `now` ist als Methoden-Parameter injizierbar (Adapter-Muster), damit Tests
 * deterministisch über Fensterwechsel steuern können.
 */
class AuthRateLimiter {
    /**
     * @param {object} [options]
     * @param {number} [options.windowMs] Fenster in ms (Default 60000)
     * @param {number} [options.maxAttempts] max. Fehlversuche pro Fenster
     * @param {number} [options.maxEntries] Eintrags-Obergrenze mit Oldest-Eviction
     */
    constructor({
        windowMs = RATE_LIMIT_WINDOW_MS,
        maxAttempts = RATE_LIMIT_MAX_ATTEMPTS,
        maxEntries = RATE_LIMITER_MAX_ENTRIES,
    } = {}) {
        this.windowMs = windowMs;
        this.maxAttempts = maxAttempts;
        this.maxEntries = maxEntries;
        /** @type {Map<string, {count: number, resetAt: number}>} ip -> Zähler */
        this.entries = new Map();
    }

    /** True, wenn die IP das Fehlversuch-Budget im aktuellen Fenster überschritten hat. */
    isBlocked(ip, now = Date.now()) {
        const entry = this.entries.get(ip);
        if (!entry) return false;
        if (now >= entry.resetAt) {
            this.entries.delete(ip);
            return false;
        }
        return entry.count >= this.maxAttempts;
    }

    registerFailure(ip, now = Date.now()) {
        const entry = this.entries.get(ip);
        if (!entry || now >= entry.resetAt) {
            if (this.entries.size >= this.maxEntries) this.evictOldest();
            this.entries.set(ip, { count: 1, resetAt: now + this.windowMs });
            return;
        }
        entry.count += 1;
    }

    /** Erfolgreiche Auth löscht den Fehlversuch-Zähler der IP. */
    reset(ip) {
        this.entries.delete(ip);
    }

    /** Abgelaufene Einträge entfernen (Map klein halten). */
    sweep(now = Date.now()) {
        for (const [ip, entry] of this.entries) {
            if (now >= entry.resetAt) this.entries.delete(ip);
        }
    }

    /**
     * Platz für einen neuen Eintrag schaffen: Einträge mit dem kleinsten
     * resetAt (älteste Fenster) zuerst löschen. Die Map-Einfügereihenfolge
     * approximiert das Fenster-Alter, da Einträge nur bei Fensterwechsel
     * neu eingefügt werden.
     */
    evictOldest() {
        const sorted = [...this.entries].sort(([, a], [, b]) => a.resetAt - b.resetAt);
        const toEvict = this.entries.size - this.maxEntries + 1;
        for (let i = 0; i < toEvict && i < sorted.length; i += 1) {
            this.entries.delete(sorted[i][0]);
        }
    }
}

/**
 * Extract the bearer token from the Authorization header, or null.
 * Überlange Tokens werden wie fehlende behandelt (null → 401): Deckelung
 * gegen Ressourcen-Verbrauch, passend zum MAX_TOKEN_LENGTH der Registry.
 */
function getBearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const provided = header.slice('Bearer '.length);
    if (!provided || provided.length > MAX_TOKEN_LENGTH) return null;
    return provided;
}

/**
 * Fabrik für den Rooms-Router (Muster wie app/external-ingest.js).
 *
 * @param {object} options
 * @param {object} options.config - { adminToken, rtmpIngestUrl }
 * @param {object} options.registry Raum-Registry (app/rooms.js)
 * @param {Function} options.isValidAdminToken timing-sicherer Token-Check (server.js)
 * @param {Function} options.getIngestStatus aktive Ingests abfragen
 * @param {Function} options.stopExternalIngest Ingest stoppen (best effort)
 * @param {AuthRateLimiter} [options.rateLimiter] injizierbarer Limiter (Tests)
 * @param {Function} [options.now] injizierbare Uhr für Tests (Default Date.now)
 * @returns {express.Router}
 */
function createRoomsRouter({
    config,
    registry,
    isValidAdminToken,
    getIngestStatus,
    stopExternalIngest,
    rateLimiter,
    now,
}) {
    const router = express.Router();
    const limiter = rateLimiter || new AuthRateLimiter();
    const currentTime = () => (typeof now === 'function' ? now() : Date.now());

    // Auth-Gate: jeder Route erfordert `Authorization: Bearer <ADMIN_TOKEN>`.
    // Fail-closed ohne (oder mit bekanntem Default-)Token: 503, keine Details.
    // Fehlgeschlagene Auth-Versuche werden pro IP ratenlimitiert (429), damit
    // Brute-Force auf das ADMIN_TOKEN nicht unbegrenzt möglich ist.
    router.use((req, res, next) => {
        const adminToken = config && typeof config.adminToken === 'string' ? config.adminToken : '';
        const trimmed = adminToken.trim();
        if (!trimmed || DEFAULT_ADMIN_TOKEN_DENYLIST.includes(trimmed.toLowerCase())) {
            log.error('Rooms API request rejected: admin token misconfigured');
            return res.status(503).json({ error: 'Rooms API unavailable' });
        }
        const ip = typeof req.ip === 'string' && req.ip ? req.ip : 'unknown';
        limiter.sweep(currentTime());
        if (limiter.isBlocked(ip, currentTime())) {
            log.warn('Rooms API rate limit exceeded', { ip, path: req.path });
            return res.status(429).json({ error: 'Too many attempts' });
        }
        const provided = getBearerToken(req);
        // Never log the Authorization header value or any secret material
        if (!provided || typeof isValidAdminToken !== 'function' || !isValidAdminToken(provided)) {
            limiter.registerFailure(ip, currentTime());
            log.warn('Rooms API request unauthorized', { ip, path: req.path });
            return res.status(401).json({ error: 'Unauthorized' });
        }
        limiter.reset(ip); // erfolgreiche Auth setzt den Zähler zurück
        next();
    });

    /** Aktive Ingest-BroadcastIds als Set (leer bei Fehlern/Fehlen). */
    function getActiveIngestIds() {
        try {
            const ingests = typeof getIngestStatus === 'function' ? getIngestStatus() : [];
            const ids = new Set();
            for (const ingest of Array.isArray(ingests) ? ingests : []) {
                if (ingest && typeof ingest === 'object' && typeof ingest.broadcastId === 'string') {
                    ids.add(ingest.broadcastId);
                }
            }
            return ids;
        } catch (error) {
            log.warn('Ingest status unavailable', { error: error.message });
            return new Set();
        }
    }

    /** Öffentliche Projektion eines Raum-Records: nie Schlüsselmaterial. */
    function toSafeRecord(room, activeIngestIds) {
        return {
            id: room.id,
            name: room.name,
            sourceType: room.sourceType,
            createdAt: room.createdAt,
            lastUsedAt: room.lastUsedAt,
            rtmp: null,
            ingestActive: room.sourceType === 'rtmp' && activeIngestIds.has(room.id),
        };
    }

    router.post('/', async (req, res) => {
        // Lenient-read (extra fields ignored), strict-validate
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return res.status(400).json({ error: 'JSON body required' });
        }
        // name optional: fehlt, wird ein kurzer stabiler Name erzeugt
        let name = body.name;
        if (name === undefined || name === null) name = 'room-' + crypto.randomBytes(4).toString('hex');

        let created;
        try {
            created = registry.createRoom({ name, sourceType: body.sourceType });
        } catch (error) {
            if (error && error.code === 'RTMP_ROOMS_FULL') {
                log.warn('Room creation rejected: RTMP room cap reached');
                return res.status(409).json({ error: 'Too many active RTMP rooms' });
            }
            if (error && error.code === 'INVALID_NAME') {
                return res.status(400).json({ error: 'Invalid room name' });
            }
            if (error && error.code === 'INVALID_SOURCE') {
                return res.status(400).json({ error: 'Invalid sourceType' });
            }
            log.error('Room creation failed', { error: error && error.message });
            return res.status(500).json({ error: 'Failed to create room' });
        }
        const room = created.room;

        let rtmp = null;
        if (room.sourceType === 'rtmp') {
            // Klartext-Key genau einmal aus der Erzeugung ausgeben (Registry
            // speichert nur den Hash; KEIN zweiter setKey-Aufruf — der Schlüssel
            // würde sonst direkt nach dem Erzeugen rotiert).
            const key = created.key;
            // Default-Ingest-Server aus req.hostname ableiten: Express 5 zieht
            // daraus den Host OHNE Port (X-Forwarded-Host, sofern TRUST_PROXY
            // die Peer-Adresse erlaubt; sonst Host-Header; IPv6-Literale und
            // Komma-Listen werden behandelt). req.get('host') würde dagegen den
            // Web-Port (z. B. :3016) enthalten, der für RTMPS :1935 falsch ist.
            // RTMP_INGEST_URL überschreibt weiterhin unverändert.
            const ingestServer =
                typeof config.rtmpIngestUrl === 'string' && config.rtmpIngestUrl.trim()
                    ? config.rtmpIngestUrl.trim()
                    : `rtmps://${req.hostname}:1935/live`;
            rtmp = {
                ingestServer,
                streamKey: `${room.id}?token=${key}`,
                note: 'Stream-Key wird nur einmal angezeigt; sicher speichern. Rotation erzeugt einen neuen Key.',
            };
        }

        log.info('Room created', { id: room.id, sourceType: room.sourceType }); // nie der Key
        return res.status(201).json({
            id: room.id,
            name: room.name,
            sourceType: room.sourceType,
            createdAt: room.createdAt,
            viewerUrl: `${req.protocol}://${req.get('host')}/viewer?id=${room.id}&name=viewer`,
            rtmp,
        });
    });

    router.get('/', (req, res) => {
        const activeIngestIds = getActiveIngestIds();
        const rooms = registry.listRooms().map((room) => toSafeRecord(room, activeIngestIds));
        return res.status(200).json({ rooms });
    });

    router.get('/:id', (req, res) => {
        const id = req.params.id;
        if (!isValidRoomId(id)) return res.status(400).json({ error: 'Invalid room id' });
        const room = registry.getRoom(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        return res.status(200).json(toSafeRecord(room, getActiveIngestIds()));
    });

    router.post('/:id/rotate-key', (req, res) => {
        const id = req.params.id;
        if (!isValidRoomId(id)) return res.status(400).json({ error: 'Invalid room id' });
        try {
            const key = registry.rotateKey(id);
            log.info('Room stream key rotated', { id }); // nie der Key
            return res.status(200).json({ id, streamKey: `${id}?token=${key}` });
        } catch (error) {
            if (error && error.code === 'NOT_FOUND') {
                return res.status(404).json({ error: 'Room not found' });
            }
            if (error && error.code === 'NOT_RTMP_ROOM') {
                return res.status(409).json({ error: 'Room is not an RTMP room' });
            }
            log.error('Room key rotation failed', { id, error: error && error.message });
            return res.status(500).json({ error: 'Failed to rotate stream key' });
        }
    });

    router.delete('/:id', async (req, res) => {
        const id = req.params.id;
        if (!isValidRoomId(id)) return res.status(400).json({ error: 'Invalid room id' });
        const room = registry.getRoom(id);
        if (!room) return res.status(404).json({ error: 'Room not found' });
        if (room.sourceType === 'rtmp' && getActiveIngestIds().has(id)) {
            try {
                await stopExternalIngest(id);
            } catch (error) {
                // Best effort: der Raum wird auch bei Fehler entfernt
                log.warn('Stopping external ingest failed during room deletion', {
                    id,
                    error: error && error.message,
                });
            }
        }
        registry.deleteRoom(id);
        log.info('Room deleted', { id });
        return res.status(204).end();
    });

    return router;
}

module.exports = {
    createRoomsRouter,
    AuthRateLimiter,
    getBearerToken,
    isValidRoomId,
    ROOM_ID_PATTERN,
    MAX_TOKEN_LENGTH,
    RATE_LIMIT_WINDOW_MS,
    RATE_LIMIT_MAX_ATTEMPTS,
    RATE_LIMITER_MAX_ENTRIES,
    DEFAULT_ADMIN_TOKEN_DENYLIST,
};
