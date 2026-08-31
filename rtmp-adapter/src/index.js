'use strict';

/**
 * rtmp-adapter entrypoint: wires config, keys, auth endpoint, reconciler and
 * graceful shutdown together. Node.js >= 20, stdlib only.
 */

const os = require('node:os');
const { loadConfig } = require('./config');
const { createLogger } = require('./log');
const { KeyStore } = require('./keys');
const { RateLimiter, createAuthHandler, normalizeIp } = require('./auth');
const { createHttpServer } = require('./server');
const { Reconciler } = require('./reconciler');

const LOCAL_IP_CACHE_TTL_MS = 5000; // container recreates change the IP set

/**
 * Allowed-IP resolver with a short TTL cache: interface addresses are
 * re-read from os.networkInterfaces() at most every 5s (so a container
 * recreate with a new IP is picked up quickly) without recomputing them on
 * every auth request. Addresses are normalized (IPv4-mapped IPv6 -> IPv4),
 * matching normalizeIp() applied to the mediamtx-reported ip.
 */
function createLocalIpResolver(ttlMs = LOCAL_IP_CACHE_TTL_MS) {
    let cache = null;
    let cachedAt = -Infinity;
    function refresh(now) {
        const ips = new Set(['127.0.0.1', '::1']);
        for (const interfaces of Object.values(os.networkInterfaces())) {
            for (const iface of interfaces || []) {
                if (iface && typeof iface.address === 'string') ips.add(normalizeIp(iface.address));
            }
        }
        cache = ips;
        cachedAt = now;
    }
    return {
        has(ip) {
            if (typeof ip !== 'string') return false;
            const now = Date.now();
            if (!cache || now - cachedAt > ttlMs) refresh(now);
            return cache.has(normalizeIp(ip));
        },
    };
}

function main() {
    let config;
    try {
        config = loadConfig(process.env);
    } catch (err) {
        // Plain stderr here: no logger exists yet. Message is config-only,
        // never contains secret material.
        process.stderr.write(`rtmp-adapter: configuration error: ${err.message}\n`);
        process.exit(1);
    }

    const log = createLogger(config.logLevel);
    log.info('rtmp-adapter starting', {
        authPort: config.authPort,
        broBaseUrl: config.broBaseUrl,
        mediamtxApiBase: config.mediamtxApiBase,
        reconcileIntervalMs: config.reconcileIntervalMs,
    });

    const keyStore = new KeyStore(config.keysFile, log);
    keyStore.start();

    const localIps = createLocalIpResolver();
    const rateLimiter = new RateLimiter({ windowMs: 60000, maxAttempts: 10 });
    const handleAuth = createAuthHandler({ keyStore, localIps, rateLimiter, log });

    const reconciler = new Reconciler({ config, log });

    const server = createHttpServer({ log, handleAuth, getStatus: () => reconciler.getStatus() });
    server.listen(config.authPort, '0.0.0.0', () => {
        log.info('auth endpoint listening', { port: config.authPort });
    });

    reconciler.start();

    let shuttingDown = false;
    async function shutdown(signal, exitCode = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info('shutting down', { signal });
        try {
            await reconciler.stop(); // ffmpeg TERM/KILL + BRO stop for each ingest
        } catch (err) {
            log.error('error during reconciler shutdown', { error: err.message });
        }
        keyStore.stop();
        server.close(() => process.exit(exitCode));
        // Final safety net if sockets keep the handle alive
        setTimeout(() => process.exit(exitCode), 3000).unref();
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Crash-safe shutdown: run the SAME graceful cleanup as SIGTERM (stop
    // ffmpeg processes, best-effort BRO stop calls, close the server) and
    // only then exit with code 1.
    process.on('unhandledRejection', (reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        log.error('unhandled rejection, initiating graceful shutdown', { error: message });
        shutdown('unhandledRejection', 1);
    });

    process.on('uncaughtException', (err) => {
        log.error('uncaught exception, initiating graceful shutdown', { error: err.message });
        shutdown('uncaughtException', 1);
    });
}

main();
