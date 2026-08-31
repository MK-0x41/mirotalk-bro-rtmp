Run unit tests from `rtmp-adapter/`: `npm test` or `node --test test/`.

These tests cover pure helpers (keys, auth, ffmpeg argv, reconcile parsers) and a localhost HTTP auth/healthz server. They do **not** cover real MediaMTX, a real FFmpeg binary, or BRO integration — those are covered by the Vagrant E2E runbook.
