'use strict';

/**
 * Minimal HTTP server for the adapter (node:http only):
 *   POST /auth/publish  — mediamtx external authentication callback
 *   GET  /healthz       — liveness + cached reachability state
 *
 * The listener is compose-internal only (default :8080, never published to
 * the host). Bodies are capped at MAX_BODY_BYTES; anything else is 404.
 */

const http = require('node:http');
const { MAX_BODY_BYTES } = require('./auth');

function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
    });
    res.end(body);
}

function readJsonBody(req, limitBytes) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let rejected = false;
        const chunks = [];
        req.on('data', (chunk) => {
            if (rejected) return;
            size += chunk.length;
            if (size > limitBytes) {
                rejected = true;
                req.pause(); // stop buffering; response is sent by the caller
                reject(new Error('body too large'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (rejected) return;
            const raw = Buffer.concat(chunks).toString('utf8');
            if (raw.length === 0) {
                resolve(null);
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch {
                reject(new Error('invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * @param {object} options
 * @param {object} options.log structured logger
 * @param {Function} options.handleAuth (body) => {status, body}
 * @param {Function} options.getStatus () => health payload
 * @returns {http.Server}
 */
function createHttpServer({ log, handleAuth, getStatus }) {
    const server = http.createServer((req, res) => {
        let pathname = '/';
        try {
            pathname = new URL(req.url, 'http://internal').pathname;
        } catch {
            sendJson(res, 400, { error: 'bad request' });
            return;
        }

        if (req.method === 'POST' && pathname === '/auth/publish') {
            readJsonBody(req, MAX_BODY_BYTES)
                .then(async (body) => {
                    // Never log body/query/headers — only ip/path/action/decision.
                    // handleAuth is async (dynamic BRO authorization) and never
                    // throws; it always resolves to {status, body}.
                    const result = await handleAuth(body && typeof body === 'object' ? body : null);
                    sendJson(res, result.status, result.body);
                })
                .catch((err) => {
                    if (res.writable && !res.destroyed) {
                        sendJson(res, 400, {
                            error: err.message === 'body too large' ? 'body too large' : 'bad request',
                        });
                        if (err.message === 'body too large') {
                            // do not accept more data from this client
                            res.once('finish', () => req.socket.destroy());
                        }
                    }
                });
            return;
        }

        if (req.method === 'GET' && pathname === '/healthz') {
            const status = getStatus();
            sendJson(res, 200, { ok: true, ...status });
            return;
        }

        sendJson(res, 404, { error: 'not found' });
    });

    // Do not leak stack traces or internals on protocol errors
    server.on('clientError', (err, socket) => {
        if (socket.writable) {
            socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
        }
        log.debug('http client error', { error: err.message });
    });

    return server;
}

module.exports = { createHttpServer, sendJson };
