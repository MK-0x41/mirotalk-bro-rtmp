Run BRO-side unit tests from the repo root: `npm run test:fork` or `node --test test/`.

These tests stub `express`, `mediasoup`, and `./logs` via `Module._load` and drive the real `app/external-ingest.js` and `app/mediasoup-handler.js` functions. They do not start HTTP servers, workers, or Docker.

Not covered: real mediasoup runtime, real FFmpeg, MediaMTX, or end-to-end RTMP ingest. Use the Vagrant E2E runbook for that.
