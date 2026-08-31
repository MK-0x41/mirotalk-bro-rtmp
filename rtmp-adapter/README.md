# rtmp-adapter

Sidecar service for the MiroTalk BRO RTMP special instance. Plain Node.js
(>= 20, **zero runtime npm dependencies** — stdlib only) with three jobs:

1. **MediaMTX publisher authentication** — MediaMTX calls `POST /auth/publish`
   (authMethod: `http`) for every action; only authenticated publishers may
   publish to `live/<broadcastId>`.
2. **Reconciliation** — polls the MediaMTX v3 REST API, starts/stops FFmpeg
   per path and calls the BRO external-ingest API (`/api/v1/external-ingest/*`).
   Every 30s per running ingest it also verifies via the BRO status endpoint
   that the ingest is still listed; after a BRO restart it tears the ingest
   down and re-attaches with fresh ports/SSRCs. New ingests are deferred
   while `MAX_CONCURRENT_INGESTS` is reached.
3. **FFmpeg supervision** — pulls the internal plain RTMP stream and pushes
   H.264 (Baseline 3.1) + Opus RTP into BRO's mediasoup PlainTransports.

The service is **fail-closed**: it refuses to start without a valid
`BRO_INGEST_SECRET` (or with a known example value from the denylist), denies
every unknown/unauthorized request, keeps the last valid `keys.json` state
when the file becomes malformed, and **revokes all streams** when a
previously loaded `keys.json` disappears or becomes unreadable.

## Endpoints (compose-internal only, never published)

| Method | Path           | Purpose                                             |
| ------ | -------------- | --------------------------------------------------- |
| POST   | `/auth/publish`| MediaMTX external authentication callback           |
| GET    | `/healthz`     | `{ok, activeIngests, mediamtxReachable, broReachable}` (reachability cached from the last reconcile cycle) |

### Auth decision matrix

| Action            | Decision                                                        |
| ----------------- | --------------------------------------------------------------- |
| `publish`         | `rtmp`/`rtmps` protocol + path `live/<id>` + valid stream key (dynamic BRO authorization first when `RTMP_DYNAMIC_AUTH=true`, see env table; otherwise static keys.json); rate limited (10 failed attempts / 60s per IP → 429) |
| `read`            | Allowed **only** for the adapter's own IPs (its internal RTMP pull) |
| `api`/`metrics`/`pprof` | Allowed **only** for the adapter's own IPs (control API access) |
| `playback` / rest | 401 (v1 has no direct playback through MediaMTX)                |

MediaMTX v1.20.1 sends `{ip, user, password, token, action, path, protocol,
id, query, userAgent}` where `path` has **no** leading slash and `query` is the
**raw** query string; the pre-extracted token arrives in `token`. Note on the
publish protocol: mediamtx v1.20.1 reports `"rtmp"` for **both** the plain and
the TLS listener (there is no `"rtmps"` protocol constant in v1.20.1); `"rtmps"`
is accepted defensively for future versions, while `"rtsp"` publish is denied
(public ingest is RTMPS-only, the adapter's internal pull is plain RTMP). The
adapter accepts the path with and without a leading slash and falls back to
parsing `query` itself. Stream keys are checked by looking up the
`broadcastId` entry first and comparing `sha256(token)` with
`crypto.timingSafeEqual`; the hash is always computed and compared against a
fixed dummy buffer when the entry is missing, so the timing does not reveal
whether a broadcastId exists. IPv4-mapped IPv6 addresses
(`::ffff:127.0.0.1`) are normalized to plain IPv4 before the local-IP
comparison.

## Environment variables

| Variable                | Default                    | Description                                        |
| ----------------------- | -------------------------- | -------------------------------------------------- |
| `BRO_BASE_URL`          | `http://bro:3016`          | External ingest API base (compose service URL)     |
| `BRO_INGEST_SECRET`     | **required**               | Shared secret for the ingest API; exit(1) when unset or < 16 chars |
| `MEDIAMTX_API_BASE`     | `http://mediamtx:9997`     | MediaMTX v3 control API                            |
| `MEDIAMTX_RTMP_SOURCE`  | `rtmp://mediamtx:19350`    | Internal **plain** RTMP base the adapter pulls from |
| `ADAPTER_AUTH_PORT`     | `8080`                     | HTTP listen port for `/auth/publish` and `/healthz` |
| `KEYS_FILE`             | `/app/config/keys.json`    | Stream key hashes (mounted read-only)              |
| `RTMP_DYNAMIC_AUTH`     | `true`                     | Ask BRO (`POST /api/v1/external-ingest/authorize`, Bearer `BRO_INGEST_SECRET`) before the static keys.json check: `200 {allowed:true}` authorizes (no failure count), `{allowed:false}` **denies** (rate-limited); HTTP/network errors fall back to the static KeyStore. `false` = static keys.json only. Note: an explicit dynamic deny is final — static-keys.json deployments must set `false` (and `RTMP_REQUIRE_ROOM=false` on BRO) |
| `RECONCILE_INTERVAL_MS` | `2000`                     | MediaMTX polling interval                          |
| `MAX_CONCURRENT_INGESTS` | `4`                       | Cap on concurrent ingests; at the cap new ingests are deferred (error logged at most once per path per 60s), existing ingests unaffected |
| `FFMPEG_PATH`           | `ffmpeg`                   | FFmpeg binary                                      |
| `VIDEO_BITRATE`         | `2500k`                    | H.264 target/max bitrate (`bufsize` = 2×)          |
| `AUDIO_BITRATE`         | `128k`                     | Opus bitrate                                       |
| `KEYFRAME_SECONDS`      | `2`                        | Keyframe interval (GOP = seconds × 30 fps)         |
| `VIDEO_PRESET`          | `veryfast`                 | x264 preset                                        |
| `LOG_LEVEL`             | `info`                     | `error` / `warn` / `info` / `debug` (JSON lines)   |

## keys.json format

```json
{
    "_comment": "optional; unknown fields are ignored",
    "streams": {
        "<broadcastId>": { "keyHash": "<64 hex chars — sha256 of the stream key>" }
    }
}
```

- Loaded at startup **and** re-read via mtime polling every 5s (hot reload).
- Malformed JSON or a wrong shape keeps the last valid state (protects
  against partial writes); the error is logged.
- A **missing or unreadable** file (`ENOENT`/`EACCES`, e.g. deleted or
  permission-stripped) **after a previous successful load revokes all
  streams** (fail-closed) — deleting the file is the revocation switch.
- An explicit empty `{"streams":{}}` also revokes all streams.
- Generate a stream key hash with:
  `node -e "console.log(require('crypto').createHash('sha256').update('THE-KEY').digest('hex'))"`
- Encoders publish to `rtmps://<host>:1935/live` with stream key
  `<broadcastId>?token=<streamKey>`.
- **Never commit a real `config/keys.json`** (see `config/keys.example.json`).

## FFmpeg argument shape

Fixed argv built by the pure `buildFfmpegArgs(ingest, config)` function
(`src/ffmpeg.js`, exported for unit tests); spawned as an **argument array**
with `shell: false`. No URL contains a token (the internal RTMP pull needs
none — the adapter allow-lists its own IP for `read`).

```text
ffmpeg -loglevel warning -nostats -progress pipe:1 \
  -rw_timeout 15000000 -i rtmp://mediamtx:19350/live/<broadcastId> \
  -map 0:v:0 -c:v libx264 -profile:v baseline -level:v 3.1 \
  -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -b:v 2500k -maxrate 2500k -bufsize 5000k -g 60 -keyint_min 60 \
  -force_key_frames expr:gte(t,n_forced*2) \
  -payload_type <video.pt> -ssrc <video.ssrc> -f rtp \
  rtp://<broHost>:<video.port>?rtcp_port=<video.rtcpPort>   # ?rtcp_port only when rtcpPort != null \
  -map 0:a:0 -c:a libopus -b:a 128k -ar 48000 -ac 2 -application lowdelay \
  -payload_type <audio.pt> -ssrc <audio.ssrc> -f rtp \
  rtp://<broHost>:<audio.port>?rtcp_port=<audio.rtcpPort>
```

Notes:

- `-rw_timeout 15000000` (µs) is the generic socket read timeout for the RTMP
  input; the RTMP protocol has no own `-timeout` option.
- When the source has no audio track, FFmpeg fails on `-map 0:a:0`; the
  reconciler detects `Stream map '0:a:0' matches no streams` and retries with
  `-map 0:a:0?` (learned per broadcastId).
- Crash restarts use a 1s/2s/5s/10s/30s backoff ladder (reset after 5 min of
  stable runtime); repeated BRO start failures enter a 5 min cooldown.

## Security

- Tokens, query strings, passwords and auth headers are **never** logged
  (only `ip`, `path`, `action`, `decision`).
- All configuration is validated at startup; invalid config → exit(1).
  `BRO_INGEST_SECRET` must be ≥ 16 chars and must not match the documented
  example-value denylist (`EXAMPLE_SECRET_DENYLIST` in `src/config.js`).
- Rate limiting per IP for failed publish attempts (in-memory, capped at
  10 000 entries; when full, entries with the oldest reset windows are
  evicted first).
- The auth port must never be published to the host (compose-internal only).
- On `uncaughtException`/`unhandledRejection` the adapter runs the same
  graceful shutdown as SIGTERM (stop FFmpeg, best-effort BRO stop calls,
  close the server) and only then exits with code 1.
