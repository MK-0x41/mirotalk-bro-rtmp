'use strict';

/**
 * Unit tests for ffmpeg.js pure helpers. Does not spawn ffmpeg.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildFfmpegArgs,
    buildRtpUrl,
    doubleBitrate,
    stderrIndicatesMissingAudio,
    minimalChildEnv,
    RTMP_READ_TIMEOUT_US,
} = require('../src/ffmpeg');

function baseConfig(overrides = {}) {
    return {
        broHost: 'bro.example',
        mediamtxRtmpSource: 'rtmp://mediamtx:19350',
        videoBitrate: '2500k',
        audioBitrate: '128k',
        keyframeSeconds: 2,
        videoPreset: 'veryfast',
        ...overrides,
    };
}

function baseIngest(overrides = {}) {
    return {
        broadcastId: 'room1',
        video: { port: 50000, rtcpPort: 50001, payloadType: 96, ssrc: 111111 },
        audio: { port: 50002, rtcpPort: 50003, payloadType: 111, ssrc: 222222 },
        ...overrides,
    };
}

function pairAfter(args, flag) {
    const index = args.indexOf(flag);
    assert.ok(index !== -1, `missing flag ${flag}`);
    return args[index + 1];
}

function allPairs(args, flag) {
    const values = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === flag) values.push(args[i + 1]);
    }
    return values;
}

function assertSafeArgv(args) {
    assert.ok(Array.isArray(args));
    assert.ok(args.length > 0);
    for (const arg of args) {
        assert.equal(typeof arg, 'string');
        assert.ok(arg.length > 0);
        // Spawn uses an argv array (shell:false). Spaces / ; | & ` $ would indicate
        // accidental concatenation or injection. `?rtcp_port=` and the ffmpeg
        // force_key_frames expression are the only intentional punctuation.
        assert.doesNotMatch(arg, /[\s;|&`$]/, `unsafe argv element: ${arg}`);
    }
}

describe('doubleBitrate', () => {
    it('doubles a k-suffix bitrate and lowercases the suffix (bufsize = 2x)', () => {
        assert.equal(doubleBitrate('2500k'), '5000k');
        assert.equal(doubleBitrate('2500K'), '5000k');
        assert.equal(doubleBitrate('1M'), '2m');
        assert.equal(doubleBitrate('128'), '256');
    });

    it('rejects an invalid bitrate', () => {
        assert.throws(() => doubleBitrate('fast'), { message: /invalid bitrate/ });
    });
});

describe('buildRtpUrl', () => {
    it('omits ?rtcp_port= when rtcpPort is null or undefined', () => {
        assert.equal(buildRtpUrl('bro.example', 50000, null), 'rtp://bro.example:50000');
        assert.equal(buildRtpUrl('bro.example', 50000, undefined), 'rtp://bro.example:50000');
    });

    it('appends ?rtcp_port= only when rtcpPort is a non-null integer', () => {
        assert.equal(buildRtpUrl('bro.example', 50000, 50001), 'rtp://bro.example:50000?rtcp_port=50001');
    });
});

describe('buildFfmpegArgs', () => {
    it('builds a full argv for video+audio with payload_type/ssrc per kind', () => {
        const args = buildFfmpegArgs(baseIngest(), baseConfig());
        assertSafeArgv(args);

        assert.equal(pairAfter(args, '-i'), 'rtmp://mediamtx:19350/live/room1');
        assert.equal(pairAfter(args, '-rw_timeout'), String(RTMP_READ_TIMEOUT_US));
        assert.ok(!args.includes('-re'));

        const payloadTypes = allPairs(args, '-payload_type');
        const ssrcs = allPairs(args, '-ssrc');
        assert.deepEqual(payloadTypes, ['96', '111']);
        assert.deepEqual(ssrcs, ['111111', '222222']);

        const rtpUrls = args.filter((arg) => arg.startsWith('rtp://'));
        assert.deepEqual(rtpUrls, [
            'rtp://bro.example:50000?rtcp_port=50001',
            'rtp://bro.example:50002?rtcp_port=50003',
        ]);

        assert.equal(pairAfter(args, '-b:v'), '2500k');
        assert.equal(pairAfter(args, '-maxrate'), '2500k');
        assert.equal(pairAfter(args, '-bufsize'), '5000k');
        assert.equal(pairAfter(args, '-g'), '60');
        assert.equal(pairAfter(args, '-keyint_min'), '60');
        assert.equal(pairAfter(args, '-force_key_frames'), 'expr:gte(t,n_forced*2)');

        const maps = allPairs(args, '-map');
        assert.deepEqual(maps, ['0:v:0', '0:a:0']);
    });

    it('omits ?rtcp_port= on both RTP URLs when rtcpPort is null', () => {
        const args = buildFfmpegArgs(
            baseIngest({
                video: { port: 50000, rtcpPort: null, payloadType: 96, ssrc: 111111 },
                audio: { port: 50002, rtcpPort: null, payloadType: 111, ssrc: 222222 },
            }),
            baseConfig()
        );
        const rtpUrls = args.filter((arg) => arg.startsWith('rtp://'));
        assert.deepEqual(rtpUrls, ['rtp://bro.example:50000', 'rtp://bro.example:50002']);
        assert.ok(rtpUrls.every((url) => !url.includes('rtcp_port')));
    });

    it('switches the audio map to 0:a:0? when audioOptional is set', () => {
        const args = buildFfmpegArgs(baseIngest({ audioOptional: true }), baseConfig());
        assert.deepEqual(allPairs(args, '-map'), ['0:v:0', '0:a:0?']);
    });

    it('applies VIDEO_BITRATE / KEYFRAME_SECONDS from the config object', () => {
        const args = buildFfmpegArgs(
            baseIngest(),
            baseConfig({ videoBitrate: '1000k', keyframeSeconds: 3, videoPreset: 'ultrafast' })
        );
        assert.equal(pairAfter(args, '-b:v'), '1000k');
        assert.equal(pairAfter(args, '-maxrate'), '1000k');
        assert.equal(pairAfter(args, '-bufsize'), '2000k');
        assert.equal(pairAfter(args, '-g'), '90');
        assert.equal(pairAfter(args, '-keyint_min'), '90');
        assert.equal(pairAfter(args, '-force_key_frames'), 'expr:gte(t,n_forced*3)');
        assert.equal(pairAfter(args, '-preset'), 'ultrafast');
    });

    it('derives RTP hosts from config.broHost (BRO_BASE_URL hostname)', () => {
        const args = buildFfmpegArgs(baseIngest(), baseConfig({ broHost: '10.0.0.5' }));
        const rtpUrls = args.filter((arg) => arg.startsWith('rtp://'));
        assert.ok(rtpUrls.every((url) => url.startsWith('rtp://10.0.0.5:')));
    });

    it('rejects malformed ingest tracks (missing/NaN/string/negative port)', () => {
        assert.throws(() => buildFfmpegArgs(null, baseConfig()), { message: /ingest is required/ });
        assert.throws(
            () => buildFfmpegArgs(baseIngest({ video: { ...baseIngest().video, port: undefined } }), baseConfig()),
            { message: /video\.port/ }
        );
        assert.throws(
            () => buildFfmpegArgs(baseIngest({ video: { ...baseIngest().video, port: '50000' } }), baseConfig()),
            { message: /video\.port/ }
        );
        assert.throws(
            () => buildFfmpegArgs(baseIngest({ video: { ...baseIngest().video, port: -1 } }), baseConfig()),
            { message: /video\.port/ }
        );
        assert.throws(
            () => buildFfmpegArgs(baseIngest({ audio: { ...baseIngest().audio, ssrc: Number.NaN } }), baseConfig()),
            { message: /audio\.ssrc/ }
        );
        assert.throws(
            () => buildFfmpegArgs(baseIngest({ broadcastId: 'live/../x' }), baseConfig()),
            { message: /broadcastId/ }
        );
    });
});

describe('stderrIndicatesMissingAudio', () => {
    it('detects the learned no-audio map error', () => {
        assert.equal(
            stderrIndicatesMissingAudio("Stream map '0:a:0' matches no streams"),
            true
        );
        assert.equal(stderrIndicatesMissingAudio('unrelated warning'), false);
        assert.equal(stderrIndicatesMissingAudio(null), false);
    });
});

describe('minimalChildEnv', () => {
    it('does not leak BRO_INGEST_SECRET into the child environment', () => {
        const previous = process.env.BRO_INGEST_SECRET;
        process.env.BRO_INGEST_SECRET = 'fake-ingest-secret-value-32ch';
        try {
            const env = minimalChildEnv();
            assert.equal(env.BRO_INGEST_SECRET, undefined);
            assert.ok(!Object.prototype.hasOwnProperty.call(env, 'BRO_INGEST_SECRET'));
        } finally {
            if (previous === undefined) delete process.env.BRO_INGEST_SECRET;
            else process.env.BRO_INGEST_SECRET = previous;
        }
    });
});
