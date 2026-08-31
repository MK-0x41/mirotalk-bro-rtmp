'use strict';

/**
 * FFmpeg process management for RTMP -> RTP ingestion.
 *
 * The adapter pulls the already-authenticated stream from mediamtx over the
 * internal plain RTMP port (no token in any URL) and transcodes:
 *   video: H.264 Baseline 3.1, fixed GOP, bitrate-capped -> RTP
 *   audio: Opus 48 kHz stereo lowdelay                     -> RTP
 *
 * buildFfmpegArgs() is a PURE function (exported for unit tests); the process
 * is spawned with an argument ARRAY and shell:false, so no user-controlled
 * value can ever reach a shell.
 */

const { spawn } = require('node:child_process');

const RTMP_READ_TIMEOUT_US = 15 * 1000 * 1000; // 15s in microseconds
const STDERR_TAIL_BYTES = 8192;
const PROGRESS_LOG_INTERVAL_MS = 30000;

/** Double an ffmpeg bitrate like "2500k" -> "5000k" (pure). */
function doubleBitrate(bitrate) {
    const match = /^([0-9]+)([kKmM]?)$/.exec(String(bitrate));
    if (!match) {
        throw new Error(`invalid bitrate: ${bitrate}`);
    }
    return `${Number(match[1]) * 2}${match[2].toLowerCase()}`;
}

/**
 * RTP output URL. `?rtcp_port=` is appended ONLY when rtcpPort is a non-null
 * integer (BRO reports null until the first RTCP packet; ffmpeg then uses
 * rtp_port + 1 which matches mediasoup's paired port allocation).
 */
function buildRtpUrl(host, port, rtcpPort) {
    if (typeof host !== 'string' || host.length === 0) {
        throw new Error('RTP host must be a non-empty string');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('RTP port must be an integer between 1 and 65535');
    }
    let url = `rtp://${host}:${port}`;
    if (rtcpPort !== null && rtcpPort !== undefined) {
        if (!Number.isInteger(rtcpPort) || rtcpPort < 1 || rtcpPort > 65535) {
            throw new Error('RTCP port must be an integer between 1 and 65535');
        }
        url += `?rtcp_port=${rtcpPort}`;
    }
    return url;
}

function validateIngestTrack(track, name) {
    if (!track || typeof track !== 'object') {
        throw new Error(`ingest.${name} is required`);
    }
    if (!Number.isInteger(track.port) || track.port < 1 || track.port > 65535) {
        throw new Error(`ingest.${name}.port must be an integer between 1 and 65535`);
    }
    if (track.rtcpPort !== null && track.rtcpPort !== undefined && !Number.isInteger(track.rtcpPort)) {
        throw new Error(`ingest.${name}.rtcpPort must be an integer or null`);
    }
    if (!Number.isInteger(track.payloadType) || track.payloadType < 0 || track.payloadType > 127) {
        throw new Error(`ingest.${name}.payloadType must be an integer between 0 and 127`);
    }
    if (!Number.isInteger(track.ssrc) || track.ssrc < 1 || track.ssrc > 0x7fffffff) {
        throw new Error(`ingest.${name}.ssrc must be a positive 31-bit integer`);
    }
}

/**
 * Build the FFmpeg argument array (PURE, no side effects, exported for tests).
 *
 * @param {object} ingest BRO start response:
 *   { broadcastId, video:{port,rtcpPort|null,payloadType,ssrc},
 *     audio:{port,rtcpPort|null,payloadType,ssrc}, audioOptional?:boolean }
 * @param {object} config adapter config (broHost, mediamtxRtmpSource, bitrates,
 *   keyframeSeconds, videoPreset)
 * @returns {string[]} ffmpeg argv
 */
function buildFfmpegArgs(ingest, config) {
    if (!ingest || typeof ingest !== 'object') {
        throw new Error('ingest is required');
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(ingest.broadcastId)) {
        throw new Error('ingest.broadcastId must match [A-Za-z0-9_-]{1,128}');
    }
    validateIngestTrack(ingest.video, 'video');
    validateIngestTrack(ingest.audio, 'audio');

    const inputUrl = `${config.mediamtxRtmpSource}/live/${ingest.broadcastId}`;
    const gop = config.keyframeSeconds * 30; // assume ~30 fps for GOP sizing

    return [
        '-loglevel',
        'warning',
        '-nostats',
        '-progress',
        'pipe:1',
        // live source: no -re; abort when the RTMP source stalls for 15s
        '-rw_timeout',
        String(RTMP_READ_TIMEOUT_US),
        '-i',
        inputUrl,
        // ---- output 1: video -> RTP
        '-map',
        '0:v:0',
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-level:v',
        '3.1',
        '-preset',
        config.videoPreset,
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-b:v',
        config.videoBitrate,
        '-maxrate',
        config.videoBitrate,
        '-bufsize',
        doubleBitrate(config.videoBitrate),
        '-g',
        String(gop),
        '-keyint_min',
        String(gop),
        '-force_key_frames',
        `expr:gte(t,n_forced*${config.keyframeSeconds})`,
        '-payload_type',
        String(ingest.video.payloadType),
        '-ssrc',
        String(ingest.video.ssrc),
        '-f',
        'rtp',
        buildRtpUrl(config.broHost, ingest.video.port, ingest.video.rtcpPort ?? null),
        // ---- output 2: audio -> RTP ("?" = learned optional map for sources
        // without an audio track)
        '-map',
        ingest.audioOptional ? '0:a:0?' : '0:a:0',
        '-c:a',
        'libopus',
        '-b:a',
        config.audioBitrate,
        '-ar',
        '48000',
        '-ac',
        '2',
        '-application',
        'lowdelay',
        '-payload_type',
        String(ingest.audio.payloadType),
        '-ssrc',
        String(ingest.audio.ssrc),
        '-f',
        'rtp',
        buildRtpUrl(config.broHost, ingest.audio.port, ingest.audio.rtcpPort ?? null),
    ];
}

/**
 * Minimal environment for the FFmpeg child: never inherit secrets (e.g.
 * BRO_INGEST_SECRET) into the media process.
 */
function minimalChildEnv() {
    const keep = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TZ'];
    const env = {};
    for (const key of keep) {
        if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    return env;
}

/**
 * Spawn one FFmpeg process. stdio pipes are captured; minimal progress
 * (frame/time) is logged at debug every 30s. stderr is kept as a tail buffer
 * for exit diagnostics (audio-map detection). No shell involved.
 *
 * @returns {{child: object, getStderrTail: function():string}}
 */
function spawnFfmpegProcess({ ffmpegPath, args, log, broadcastId }) {
    const child = spawn(ffmpegPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        env: minimalChildEnv(),
        windowsHide: true,
    });

    let stderrTail = '';
    let stdoutBuffer = '';
    let progress = { frame: null, outTimeMs: null };
    let lastProgressLog = 0;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
        for (const line of chunk.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) {
                // ffmpeg warnings/errors; never contains stream keys (input
                // URL is the internal token-less RTMP pull)
                log.debug('ffmpeg stderr', { broadcastId, line: trimmed.slice(0, 500) });
            }
        }
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
            const [key, value] = line.split('=', 2);
            if (key === 'frame') progress.frame = value;
            else if (key === 'out_time_ms') progress.outTimeMs = value;
            else if (key === 'progress') {
                const now = Date.now();
                if (now - lastProgressLog >= PROGRESS_LOG_INTERVAL_MS) {
                    lastProgressLog = now;
                    log.debug('ffmpeg progress', {
                        broadcastId,
                        frame: progress.frame,
                        outTimeMs: progress.outTimeMs,
                    });
                }
                progress = { frame: null, outTimeMs: null };
            }
        }
    });

    return {
        child,
        getStderrTail: () => stderrTail,
    };
}

/** True when ffmpeg stderr indicates the source has no audio track. */
function stderrIndicatesMissingAudio(stderrTail) {
    return typeof stderrTail === 'string' && stderrTail.includes('matches no streams') && stderrTail.includes('0:a:0');
}

module.exports = {
    buildFfmpegArgs,
    buildRtpUrl,
    doubleBitrate,
    spawnFfmpegProcess,
    stderrIndicatesMissingAudio,
    minimalChildEnv,
    RTMP_READ_TIMEOUT_US,
};
