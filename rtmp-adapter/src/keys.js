'use strict';

/**
 * Stream key store backed by keys.json.
 *
 * Format (see config/keys.example.json):
 *   { "streams": { "<broadcastId>": { "keyHash": "<64 hex chars sha256>" } } }
 *
 * The file is loaded at startup and re-read via mtime polling every 5s
 * (fs.watchFile) for hot reload. Semantics (fail-closed):
 *   - malformed JSON / wrong shape -> keep the last valid state (protects
 *     against partial writes); the error is logged.
 *   - missing or unreadable (ENOENT/EACCES) AFTER a previous successful
 *     load -> revoke ALL streams (deleting the file is the revocation
 *     switch); the error is logged.
 *   - an empty {"streams":{}} revokes all streams (valid, not malformed).
 *
 * The parsed store uses a null prototype: broadcastId keys like "__proto__"
 * or "constructor" must not pollute (or resolve via) Object.prototype.
 */

const fs = require('node:fs');

const KEY_HASH_RE = /^[0-9a-f]{64}$/;
const BROADCAST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WATCH_INTERVAL_MS = 5000;

/**
 * Pure parser/validator. Throws an Error with a safe message on any problem.
 * Unknown top-level or entry fields are ignored (allows `_comment` docs).
 */
function parseKeys(content) {
    let data;
    try {
        data = JSON.parse(content);
    } catch {
        throw new Error('keys.json is not valid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('keys.json must contain a JSON object');
    }
    const streams = data.streams;
    if (!streams || typeof streams !== 'object' || Array.isArray(streams)) {
        throw new Error('keys.json must contain a "streams" object');
    }
    const parsed = Object.create(null);
    for (const [broadcastId, entry] of Object.entries(streams)) {
        if (!BROADCAST_ID_RE.test(broadcastId)) {
            throw new Error('keys.json contains an invalid broadcastId (allowed: [A-Za-z0-9_-]{1,128})');
        }
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            throw new Error(`streams["${broadcastId}"] must be an object`);
        }
        if (typeof entry.keyHash !== 'string') {
            throw new Error(`streams["${broadcastId}"].keyHash must be a string`);
        }
        const keyHash = entry.keyHash.trim().toLowerCase();
        if (!KEY_HASH_RE.test(keyHash)) {
            throw new Error(`streams["${broadcastId}"].keyHash must be 64 lowercase hex chars (sha256)`);
        }
        parsed[broadcastId] = { keyHash };
    }
    return { streams: parsed };
}

class KeyStore {
    /**
     * @param {string} file path to keys.json
     * @param {object} log structured logger
     */
    constructor(file, log) {
        this.file = file;
        this.log = log;
        this.streams = Object.create(null);
        this.loadedOnce = false;
        this.watching = false;
    }

    /** Initial load + start mtime-polling watch. */
    start() {
        this.load();
        fs.watchFile(this.file, { interval: WATCH_INTERVAL_MS, persistent: false }, () => this.load());
        this.watching = true;
    }

    stop() {
        if (this.watching) {
            fs.unwatchFile(this.file);
            this.watching = false;
        }
    }

    /**
     * Reload keys.json.
     *   - malformed JSON / wrong shape -> keep the last valid state;
     *   - missing/unreadable (ENOENT/EACCES) after a previous successful
     *     load -> revoke ALL streams (fail-closed).
     */
    load() {
        let content;
        try {
            content = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            if (this.loadedOnce && (err.code === 'ENOENT' || err.code === 'EACCES')) {
                // Deleting (or making unreadable) the file after a valid load
                // is an explicit revocation: clear every stream, fail closed.
                this.streams = Object.create(null);
                this.log.error('keys.json missing or unreadable after a previous valid load, all streams revoked', {
                    error: err.message,
                });
                return false;
            }
            this.log.error('keys.json unreadable, keeping last valid state', { error: err.message });
            return false;
        }
        try {
            const parsed = parseKeys(content);
            this.streams = parsed.streams;
            this.loadedOnce = true;
            this.log.info('keys.json loaded', { streamCount: Object.keys(this.streams).length });
            return true;
        } catch (err) {
            this.log.error('keys.json malformed, keeping last valid state', { error: err.message });
            return false;
        }
    }

    /** Entry for a broadcastId, or null. Lookup by key, never by iteration. */
    get(broadcastId) {
        return Object.prototype.hasOwnProperty.call(this.streams, broadcastId) ? this.streams[broadcastId] : null;
    }
}

module.exports = { KeyStore, parseKeys };
