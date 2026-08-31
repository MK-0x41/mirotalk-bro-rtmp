'use strict';

/**
 * MiroTalk BRO - External ingest API
 *
 * Allows an external trusted process (e.g. the rtmp-adapter sidecar) to inject
 * RTP media (H.264 video + Opus audio) into an SFU broadcast room via mediasoup
 * PlainTransports, so existing viewers consume it like normal producers.
 *
 * INTERNAL USE ONLY: this API must never be exposed to public networks
 * (compose/internal network only). It is mounted by server.js under
 * /api/v1/external-ingest only when EXTERNAL_INGEST_ENABLED=true.
 */

const crypto = require('crypto');
const express = require('express');

const logs = require('./logs');
const log = new logs('external-ingest');

// broadcastId charset, aligned with the ids used by /broadcast and /viewer
const BROADCAST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MIN_SECRET_LENGTH = 16;

// Well-known example values from templates and documentation. These must never
// be accepted as a real secret (configured or presented), even though they are
// long enough to pass the length check.
const EXAMPLE_SECRET_DENYLIST = ['change-me-generate-with-openssl-rand-hex-32', 'changeme-changeme-changeme'];

function isExampleSecret(value) {
    return typeof value === 'string' && EXAMPLE_SECRET_DENYLIST.includes(value.trim().toLowerCase());
}

function isValidBroadcastId(value) {
    return typeof value === 'string' && BROADCAST_ID_PATTERN.test(value);
}

/**
 * Extract the bearer token from the Authorization header, or null.
 */
function getBearerToken(req) {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const provided = header.slice('Bearer '.length);
    return provided || null;
}

/**
 * HMAC-based constant-time bearer comparison (mirrors the isValidAdminToken
 * pattern in server.js). Hashing both sides makes the comparison safe even
 * when the lengths differ, without revealing which check failed.
 */
function isAuthorizedRequest(req, secret) {
    const provided = getBearerToken(req);
    if (!provided) return false;
    const hmac = (val) => crypto.createHmac('sha256', 'external-ingest-cmp').update(val).digest();
    return crypto.timingSafeEqual(hmac(provided), hmac(secret));
}

/**
 * Factory for the external ingest router.
 *
 * @param {object} options
 * @param {object} options.config - { externalIngestEnabled: boolean, externalIngestSecret: string }
 * @param {object} options.handlers - { createExternalIngest, stopExternalIngest, getExternalIngestStatus }
 * @returns {express.Router}
 */
function createExternalIngestRouter({ config, handlers }) {
    const router = express.Router();

    // Auth and availability gate. server.js mounts this router only when
    // enabled; when disabled behave exactly like a missing route (404).
    router.use((req, res, next) => {
        if (config.externalIngestEnabled !== true) {
            return res.status(404).json({ error: 'Not found' });
        }
        const secret = config.externalIngestSecret;
        if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH || isExampleSecret(secret)) {
            // Fail closed with a generic message when the secret is misconfigured
            log.error('External ingest request rejected: secret misconfigured');
            return res.status(503).json({ error: 'External ingest unavailable' });
        }
        const provided = getBearerToken(req);
        if (provided && isExampleSecret(provided)) {
            // Same generic 503 as above: never reveal which check failed
            log.error('External ingest request rejected: presented credential is a known example value');
            return res.status(503).json({ error: 'External ingest unavailable' });
        }
        if (!isAuthorizedRequest(req, secret)) {
            // Never log the Authorization header value or any secret material
            log.warn('External ingest request unauthorized', { ip: req.ip, path: req.path });
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });

    // Validate the JSON body and return the broadcastId, or null (after
    // responding) when invalid. Lenient-read (extra fields ignored),
    // strict-validate (broadcastId must match the allowed charset).
    function getBroadcastId(req, res) {
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            res.status(400).json({ error: 'JSON body required' });
            return null;
        }
        const broadcastId = body.broadcastId;
        if (!isValidBroadcastId(broadcastId)) {
            res.status(400).json({ error: 'Invalid broadcastId' });
            return null;
        }
        return broadcastId;
    }

    router.post('/start', async (req, res) => {
        const broadcastId = getBroadcastId(req, res);
        if (!broadcastId) return;
        try {
            const info = await handlers.createExternalIngest(broadcastId);
            log.debug('External ingest start', { broadcastId });
            return res.status(200).json(info);
        } catch (error) {
            // Exclusive-source conflict from the SFU handler (room already has a
            // browser broadcaster) maps to 409; mediasoup failures stay 502
            if (error && error.status === 409) {
                log.warn('External ingest start rejected: room has a browser source', { broadcastId });
                return res.status(409).json({ error: 'Room already has a browser broadcaster' });
            }
            // Safe message only, no stack traces or internals
            log.error('External ingest start failed', { broadcastId, error: error.message });
            return res.status(502).json({ error: 'Failed to start external ingest' });
        }
    });

    router.post('/stop', async (req, res) => {
        const broadcastId = getBroadcastId(req, res);
        if (!broadcastId) return;
        try {
            await handlers.stopExternalIngest(broadcastId);
            log.debug('External ingest stop', { broadcastId });
            return res.status(200).json({ stopped: true, broadcastId });
        } catch (error) {
            log.error('External ingest stop failed', { broadcastId, error: error.message });
            return res.status(502).json({ error: 'Failed to stop external ingest' });
        }
    });

    router.get('/status', (req, res) => {
        try {
            const ingests = handlers.getExternalIngestStatus();
            return res.status(200).json({ ingests });
        } catch (error) {
            log.error('External ingest status failed', { error: error.message });
            return res.status(502).json({ error: 'Failed to get external ingest status' });
        }
    });

    return router;
}

module.exports = {
    createExternalIngestRouter,
    isAuthorizedRequest,
    isValidBroadcastId,
    isExampleSecret,
    getBearerToken,
    BROADCAST_ID_PATTERN,
    EXAMPLE_SECRET_DENYLIST,
};
