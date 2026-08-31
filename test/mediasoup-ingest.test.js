'use strict';

/**
 * Structural tests for app/mediasoup-handler.js external-ingest additions.
 * Stubs mediasoup + ./logs via Module._load and drives the real module functions.
 * No real mediasoup workers, no network, no ffmpeg.
 */

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

process.env.MEDIASOUP_NUM_WORKERS = '1';

const origLoad = Module._load;
const calls = { transports: [], produces: [], emits: [] };

class FakeProducer {
    constructor(kind, rtpParameters, appData) {
        this.kind = kind;
        this.rtpParameters = rtpParameters;
        this.appData = appData;
        this.id = `${kind}-producer-${calls.produces.length}`;
        this.closed = false;
        this.handlers = {};
    }
    on(event, fn) {
        this.handlers[event] = fn;
    }
    close() {
        this.closed = true;
    }
}

let nextPort = 40000;

class FakePlainTransport {
    constructor(options) {
        this.id = `transport-${calls.transports.length}`;
        this.options = options;
        this.tuple = { localIp: '0.0.0.0', localPort: nextPort };
        this.rtcpTuple = null;
        this.closed = false;
        nextPort += 2;
        calls.transports.push(this);
    }
    async produce({ kind, rtpParameters, appData }) {
        const producer = new FakeProducer(kind, rtpParameters, appData);
        calls.produces.push({ transport: this.id, kind, rtpParameters, appData });
        return producer;
    }
    close() {
        this.closed = true;
    }
}

const routerCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        preferredPayloadType: 100,
        parameters: {},
        rtcpFeedback: [],
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        preferredPayloadType: 101,
        parameters: {},
        rtcpFeedback: [],
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        preferredPayloadType: 103,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '4d0032', 'level-asymmetry-allowed': 1 },
        rtcpFeedback: [],
    },
    {
        kind: 'video',
        mimeType: 'video/H264',
        clockRate: 90000,
        preferredPayloadType: 104,
        parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
        rtcpFeedback: [{ type: 'nack', parameter: 'pli' }],
    },
];

class FakeRouter {
    constructor() {
        this.id = 'router-1';
        this.rtpCapabilities = { codecs: routerCodecs, headerExtensions: [] };
        this.closed = false;
    }
    async createPlainTransport(options) {
        return new FakePlainTransport(options);
    }
    close() {
        this.closed = true;
    }
}

class FakeWorker {
    constructor() {
        this.pid = 1;
    }
    on() {}
    async createRouter() {
        return new FakeRouter();
    }
}

class FakeLogs {
    constructor() {}
    debug() {}
    info() {}
    warn() {}
    error() {}
}

Module._load = function (request, parent, isMain) {
    if (request === 'mediasoup') {
        return { createWorker: async () => new FakeWorker() };
    }
    if (request === './logs') return FakeLogs;
    return origLoad.call(this, request, parent, isMain);
};

const handler = require('../app/mediasoup-handler');

function makeIo() {
    return {
        to(socketId) {
            return {
                emit(event, payload) {
                    calls.emits.push({ socketId, event, payload });
                },
            };
        },
    };
}

function resetCalls() {
    calls.transports.length = 0;
    calls.produces.length = 0;
    calls.emits.length = 0;
}

function expectedListenInfo(min, max) {
    return {
        protocol: 'udp',
        ip: '0.0.0.0',
        portRange: { min, max },
    };
}

function makeSocket(id) {
    const handlers = {};
    return {
        id,
        handlers,
        on(event, fn) {
            handlers[event] = fn;
        },
        emit(event, ...args) {
            return handlers[event](...args);
        },
    };
}

function makeCloseable() {
    return {
        closed: false,
        close() {
            this.closed = true;
        },
    };
}

describe('mediasoup external ingest', () => {
    const io = makeIo();

    before(async () => {
        await handler.createWorkers();
    });

    afterEach(async () => {
        for (const id of Object.keys(handler.sfuRooms)) {
            handler.deleteRoom(id);
        }
        resetCalls();
    });

    it('passes portRange min-max on PlainTransport listenInfo', async () => {
        await handler.createExternalIngest('range-default', io);
        assert.equal(calls.transports.length, 2);
        const expected = expectedListenInfo(41000, 41099);
        for (const transport of calls.transports) {
            assert.equal(Array.isArray(transport.options.listenInfo), false);
            assert.deepEqual(transport.options.listenInfo, expected);
            assert.deepEqual(transport.options.rtcpListenInfo, expected);
            assert.equal(typeof transport.options.listenInfo.portRange.min, 'number');
            assert.equal(typeof transport.options.listenInfo.portRange.max, 'number');
            assert.equal(typeof transport.options.rtcpListenInfo.portRange.min, 'number');
            assert.equal(typeof transport.options.rtcpListenInfo.portRange.max, 'number');
            assert.equal(transport.options.rtcpMux, false);
            assert.equal(transport.options.comedia, true);
        }
    });

    it('passes a custom options portRange through to listenInfo', async () => {
        await handler.createExternalIngest('range-custom', io, { portMin: 41500, portMax: 41510 });
        const opts = calls.transports[calls.transports.length - 1].options;
        assert.equal(Array.isArray(opts.listenInfo), false);
        assert.equal(opts.listenInfo.portRange.min, 41500);
        assert.equal(opts.listenInfo.portRange.max, 41510);
        assert.equal(opts.rtcpListenInfo.portRange.min, 41500);
        assert.equal(opts.rtcpListenInfo.portRange.max, 41510);
        assert.equal(typeof opts.listenInfo.portRange.min, 'number');
        assert.equal(typeof opts.rtcpListenInfo.portRange.max, 'number');
        assert.deepEqual(opts.listenInfo, expectedListenInfo(41500, 41510));
        assert.deepEqual(opts.rtcpListenInfo, expectedListenInfo(41500, 41510));
    });

    it('throws on RTC range overlap before creating transports', async () => {
        await assert.rejects(
            handler.createExternalIngest('overlap-room', io, { portMin: 20000, portMax: 20050 }),
            /overlaps the WebRTC RTC port range/
        );
        assert.equal(calls.transports.length, 0);
    });

    it('throws on an inverted or privileged port range before creating transports', async () => {
        await assert.rejects(
            handler.createExternalIngest('inverted-room', io, { portMin: 41100, portMax: 41050 }),
            /Invalid external ingest port range/
        );
        await assert.rejects(
            handler.createExternalIngest('low-room', io, { portMin: 80, portMax: 90 }),
            /Invalid external ingest port range/
        );
        assert.equal(calls.transports.length, 0);
    });

    it('returns 409 when a browser broadcaster or non-rtmp producer is present', async () => {
        const mixed = await handler.getOrCreateRoom('mixed-room');
        mixed.broadcasterSocketId = 'sock-broad-1';
        await assert.rejects(
            handler.createExternalIngest('mixed-room', io),
            (err) => err.status === 409
        );
        assert.equal(calls.transports.length, 0);

        mixed.broadcasterSocketId = null;
        mixed.producers.set('browser-1', { id: 'browser-1', appData: { source: 'browser' } });
        await assert.rejects(
            handler.createExternalIngest('mixed-room', io),
            (err) => err.status === 409
        );
        assert.equal(calls.transports.length, 0);
    });

    it('rejects sfu-createBroadcasterTransport when external ingest is active', async () => {
        await handler.createExternalIngest('exclusive-bc', io);
        const socket = makeSocket('sock-try-bc');
        const broadcasters = {};
        const viewers = {};
        handler.handleSfuConnection(socket, io, broadcasters, viewers);

        let callbackPayload;
        await socket.emit('sfu-createBroadcasterTransport', 'exclusive-bc', (payload) => {
            callbackPayload = payload;
        });

        assert.deepEqual(callbackPayload, {
            error: 'Room already has an external ingest, browser broadcaster is exclusive',
        });
        const room = handler.getRoom('exclusive-bc');
        assert.equal(room.externalIngest.active, true);
        assert.equal(room.broadcasterSocketId, null);
        assert.equal(broadcasters['exclusive-bc'], undefined);
    });

    it('is idempotent and returns the start contract shape', async () => {
        const info1 = await handler.createExternalIngest('rtmp-room', io);
        assert.deepEqual(Object.keys(info1).sort(), ['audio', 'broadcastId', 'video']);
        assert.equal(info1.broadcastId, 'rtmp-room');
        for (const kind of ['video', 'audio']) {
            assert.deepEqual(Object.keys(info1[kind]).sort(), ['payloadType', 'port', 'profile', 'rtcpPort', 'ssrc']);
            assert.equal(typeof info1[kind].port, 'number');
            assert.equal(info1[kind].rtcpPort, null);
            assert.equal(typeof info1[kind].ssrc, 'number');
            assert.ok(info1[kind].ssrc >= 1 && info1[kind].ssrc <= 0x7fffffff);
        }
        assert.equal(info1.video.payloadType, 104);
        assert.equal(info1.video.profile, '42e01f');
        assert.equal(info1.audio.payloadType, 100);
        assert.equal(info1.audio.profile, null);

        const transportsBefore = calls.transports.length;
        const producesBefore = calls.produces.length;
        const info2 = await handler.createExternalIngest('rtmp-room', io);
        assert.equal(calls.transports.length, transportsBefore);
        assert.equal(calls.produces.length, producesBefore);
        assert.deepEqual(info2, info1);
    });

    it('stopExternalIngest closes producers and transports and is a no-op when absent', async () => {
        await handler.createExternalIngest('stop-room', io);
        const ingest = handler.getRoom('stop-room').externalIngest;
        await handler.stopExternalIngest('stop-room');
        assert.equal(ingest.videoProducer.closed, true);
        assert.equal(ingest.audioProducer.closed, true);
        assert.equal(ingest.videoTransport.closed, true);
        assert.equal(ingest.audioTransport.closed, true);
        assert.equal(handler.getRoom('stop-room'), null);

        await handler.stopExternalIngest('does-not-exist');
    });

    it('deletes an empty hadExternalIngest room after the last viewer leaves', async () => {
        await handler.createExternalIngest('leak-room', io);
        handler.getRoom('leak-room').viewers.set('sock-lv', { username: 'lv' });
        const viewers = { 'sock-lv': { broadcastID: 'leak-room', username: 'lv' } };
        await handler.stopExternalIngest('leak-room');
        assert.ok(handler.getRoom('leak-room'));
        handler.handleSfuDisconnect({ id: 'sock-lv' }, {}, viewers, io);
        assert.equal(handler.getRoom('leak-room'), null);
    });

    it('does not delete a room while externalIngest is active', async () => {
        await handler.createExternalIngest('keep-room', io);
        handler.getRoom('keep-room').viewers.set('sock-kv', { username: 'kv' });
        const viewers = { 'sock-kv': { broadcastID: 'keep-room', username: 'kv' } };
        handler.handleSfuDisconnect({ id: 'sock-kv' }, {}, viewers, io);
        assert.ok(handler.getRoom('keep-room'));
        assert.equal(handler.getRoom('keep-room').externalIngest.active, true);
    });

    it('clears stale broadcaster state after grace when external ingest is active', async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });

        await handler.createExternalIngest('grace-room', io);
        const room = handler.getRoom('grace-room');
        const transport = makeCloseable();
        const recvTransport = makeCloseable();
        const sendTransport = makeCloseable();
        room.broadcasterSocketId = 'sock-bc';
        room.broadcasterTransport = transport;
        room.viewers.set('sock-bc', { username: 'bc', recvTransport, sendTransport });
        room.viewers.set('sock-viewer', { username: 'v' });

        const broadcasters = { 'grace-room': 'sock-bc' };
        const viewers = { 'sock-bc': { broadcastID: 'grace-room', username: 'bc' } };

        const handled = handler.handleSfuDisconnect({ id: 'sock-bc' }, broadcasters, viewers, io);
        assert.equal(handled, true);
        assert.equal(room.broadcasterSocketId, 'sock-bc');
        assert.equal(room.broadcasterTransport, transport);

        t.mock.timers.tick(5000);

        assert.equal(room.broadcasterSocketId, null);
        assert.equal(room.broadcasterTransport, null);
        assert.equal(transport.closed, true);
        assert.equal(room.viewers.has('sock-bc'), false);
        assert.equal(recvTransport.closed, true);
        assert.equal(sendTransport.closed, true);
        assert.equal(room.viewers.has('sock-viewer'), true);
        assert.ok(handler.getRoom('grace-room'));
        assert.equal(handler.getRoom('grace-room').externalIngest.active, true);
        assert.equal(broadcasters['grace-room'], undefined);
        assert.equal(viewers['sock-bc'], undefined);
    });

    it('leaves a browser-only room (no hadExternalIngest marker) on last-viewer leave', async () => {
        const room = await handler.getOrCreateRoom('browser-only');
        room.viewers.set('sock-bv', { username: 'bv' });
        const viewers = { 'sock-bv': { broadcastID: 'browser-only', username: 'bv' } };
        handler.handleSfuDisconnect({ id: 'sock-bv' }, {}, viewers, io);
        assert.ok(handler.getRoom('browser-only'));
        assert.equal(handler.getRoom('browser-only').hadExternalIngest, false);
    });

    it('getExternalIngestStatus reports active ingest ids and producer ids', async () => {
        assert.deepEqual(handler.getExternalIngestStatus(), []);
        const info = await handler.createExternalIngest('status-room', io);
        const status = handler.getExternalIngestStatus();
        assert.equal(status.length, 1);
        assert.deepEqual(Object.keys(status[0]).sort(), [
            'audioProducerId',
            'broadcastId',
            'startedAt',
            'videoProducerId',
        ]);
        assert.equal(status[0].broadcastId, info.broadcastId);
        assert.equal(typeof status[0].startedAt, 'string');
        assert.equal(typeof status[0].videoProducerId, 'string');
        assert.equal(typeof status[0].audioProducerId, 'string');
    });
});
