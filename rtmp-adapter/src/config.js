'use strict';

/**
 * Environment configuration for the rtmp-adapter (fail-closed).
 *
 * Every value is validated at startup; the process refuses to start on
 * missing or malformed configuration instead of running in an unsafe state.
 */

class ConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigError';
    }
}

const VIDEO_PRESETS = new Set([
    'ultrafast',
    'superfast',
    'veryfast',
    'faster',
    'fast',
    'medium',
    'slow',
    'slower',
    'veryslow',
]);

const BITRATE_RE = /^[0-9]+[kKmM]?$/;
const LOG_LEVELS = new Set(['error', 'warn', 'info', 'debug']);
const MIN_SECRET_LENGTH = 16;

/**
 * Documented example/placeholder secrets that must never be used as the real
 * BRO_INGEST_SECRET. Compared case-insensitively; matched values that pass
 * the length check still refuse to start (fail-closed). Exported for tests.
 */
const EXAMPLE_SECRET_DENYLIST = [
    'change-me-generate-with-openssl-rand-hex-32',
    'changeme-changeme-changeme',
];

function requiredPort(value, name) {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new ConfigError(`${name} must be a TCP port between 1 and 65535 (got: ${value})`);
    }
    return port;
}

function requiredHttpUrl(value, name) {
    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new ConfigError(`${name} must be a valid http(s) URL (got: ${value})`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new ConfigError(`${name} must use http or https (got: ${value})`);
    }
    if (parsed.username || parsed.password || parsed.pathname !== '/') {
        // Credentials or paths in the base URL are a misconfiguration; the
        // adapter composes sub-paths itself and never handles credentials.
        throw new ConfigError(`${name} must be a bare base URL without credentials or path`);
    }
    return parsed;
}

function loadConfig(env = process.env) {
    // RTMP_DYNAMIC_AUTH: 'true'/'false', default 'true' (unset or empty).
    const dynamicAuthRaw =
        env.RTMP_DYNAMIC_AUTH === undefined || env.RTMP_DYNAMIC_AUTH === '' ? 'true' : env.RTMP_DYNAMIC_AUTH;
    if (dynamicAuthRaw !== 'true' && dynamicAuthRaw !== 'false') {
        throw new ConfigError('RTMP_DYNAMIC_AUTH must be true or false');
    }

    const config = {
        broBaseUrl: env.BRO_BASE_URL || 'http://bro:3016',
        ingestSecret: env.BRO_INGEST_SECRET || '',
        mediamtxApiBase: env.MEDIAMTX_API_BASE || 'http://mediamtx:9997',
        mediamtxRtmpSource: env.MEDIAMTX_RTMP_SOURCE || 'rtmp://mediamtx:19350',
        authPort: requiredPort(env.ADAPTER_AUTH_PORT || '8080', 'ADAPTER_AUTH_PORT'),
        keysFile: env.KEYS_FILE || '/app/config/keys.json',
        reconcileIntervalMs: Number.parseInt(env.RECONCILE_INTERVAL_MS || '2000', 10),
        maxConcurrentIngests: Number.parseInt(env.MAX_CONCURRENT_INGESTS || '4', 10),
        ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
        videoBitrate: env.VIDEO_BITRATE || '2500k',
        audioBitrate: env.AUDIO_BITRATE || '128k',
        keyframeSeconds: Number.parseInt(env.KEYFRAME_SECONDS || '2', 10),
        videoPreset: env.VIDEO_PRESET || 'veryfast',
        logLevel: (env.LOG_LEVEL || 'info').toLowerCase(),
        dynamicAuth: dynamicAuthRaw === 'true',
    };

    // BRO_INGEST_SECRET: hard requirement, fail-closed.
    if (typeof config.ingestSecret !== 'string' || config.ingestSecret.length < MIN_SECRET_LENGTH) {
        throw new ConfigError(
            `BRO_INGEST_SECRET is required and must be at least ${MIN_SECRET_LENGTH} characters long. ` +
                'Generate one with e.g. `openssl rand -hex 32`. Refusing to start (fail-closed).'
        );
    }
    // A documented example value that passed the length check is still a
    // publicly known secret -> refuse to start (fail-closed).
    if (EXAMPLE_SECRET_DENYLIST.includes(config.ingestSecret.trim().toLowerCase())) {
        throw new ConfigError(
            'BRO_INGEST_SECRET matches a known example value from the documentation. ' +
                'Generate a real secret with e.g. `openssl rand -hex 32`. Refusing to start (fail-closed).'
        );
    }

    const broUrl = requiredHttpUrl(config.broBaseUrl, 'BRO_BASE_URL');
    config.broBaseUrl = broUrl.origin;
    config.broHost = broUrl.hostname;

    requiredHttpUrl(config.mediamtxApiBase, 'MEDIAMTX_API_BASE');

    // The RTMP source must be a plain internal RTMP URL, without credentials.
    if (!/^rtmp:\/\/[^@/]+:\d+\/?$/.test(config.mediamtxRtmpSource)) {
        throw new ConfigError(
            `MEDIAMTX_RTMP_SOURCE must be a plain internal RTMP base URL like rtmp://mediamtx:19350 ` +
                `(no credentials, no path, no rtmps) (got: ${config.mediamtxRtmpSource})`
        );
    }
    config.mediamtxRtmpSource = config.mediamtxRtmpSource.replace(/\/+$/, '');

    if (
        !Number.isInteger(config.reconcileIntervalMs) ||
        config.reconcileIntervalMs < 250 ||
        config.reconcileIntervalMs > 600000
    ) {
        throw new ConfigError('RECONCILE_INTERVAL_MS must be an integer between 250 and 600000');
    }

    if (!Number.isInteger(config.maxConcurrentIngests) || config.maxConcurrentIngests < 1) {
        throw new ConfigError('MAX_CONCURRENT_INGESTS must be an integer >= 1');
    }

    if (!Number.isInteger(config.keyframeSeconds) || config.keyframeSeconds < 1 || config.keyframeSeconds > 10) {
        throw new ConfigError('KEYFRAME_SECONDS must be an integer between 1 and 10');
    }

    if (!BITRATE_RE.test(config.videoBitrate)) {
        throw new ConfigError(`VIDEO_BITRATE must match ^[0-9]+[kKmM]?$ (got: ${config.videoBitrate})`);
    }
    if (!BITRATE_RE.test(config.audioBitrate)) {
        throw new ConfigError(`AUDIO_BITRATE must match ^[0-9]+[kKmM]?$ (got: ${config.audioBitrate})`);
    }

    if (!VIDEO_PRESETS.has(config.videoPreset)) {
        throw new ConfigError(`VIDEO_PRESET must be one of: ${[...VIDEO_PRESETS].join(', ')}`);
    }

    if (!LOG_LEVELS.has(config.logLevel)) {
        throw new ConfigError(`LOG_LEVEL must be one of: ${[...LOG_LEVELS].join(', ')}`);
    }

    if (typeof config.ffmpegPath !== 'string' || config.ffmpegPath.length === 0) {
        throw new ConfigError('FFMPEG_PATH must not be empty');
    }

    return config;
}

module.exports = { loadConfig, ConfigError, EXAMPLE_SECRET_DENYLIST, MIN_SECRET_LENGTH };
