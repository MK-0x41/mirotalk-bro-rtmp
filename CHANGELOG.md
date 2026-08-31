## Unreleased

### Added

- External-Ingest-API auf Basis von mediasoup-`PlainTransport` für H.264- und
  Opus-RTP aus RTMP-Zuführungen in SFU-Räume; externe Quellen sind pro Raum
  exklusiv (beidseitige Prüfung, HTTP 409).
- Raum-Lifecycle mit `hadExternalIngest`-Marker und Grace-Detach.
- `rtmp-adapter`-Sidecar mit MediaMTX-HTTP-Auth und SHA-256-Stream-Keys,
  Reconciler mit BRO-Restart-Reattach, FFmpeg-Orchestrierung und
  `MAX_CONCURRENT_INGESTS`.
- MediaMTX v1.20.1 digest-gepinnt mit RTMPS auf Port 1935, internem RTMP auf
  Port 19350 und REST-API auf Port 9997.
- Docker-Compose-Stack und Dev-Override; Dev-Bindings werden ausschließlich am
  privaten Vagrant-Netz angelegt.
- Vagrant-Dev-VM (`debian/trixie64`, libvirt, `192.168.56.5`) sowie die
  `dev_deploy`- und `dev_teardown`-Playbooks.
- Tests: 33 BRO-seitige Tests (`test/`, `npm run test:fork`) und 95
  Adapter-Tests.
- `SPEC.md` und das RTMP-Runbook.

### Changed

- `.gitignore` trackt `docker-compose.yml`; Schlüssel, Zertifikate und
  Inventare bleiben ignoriert.
- `.env.template` enthält `EXTERNAL_INGEST_*` sowie den
  Ingest-Portbereich `41000–41099`.
- `package.json` enthält das Skript `test:fork`.

### Fixed

- Keine Einträge.

### Security

- Authorization- und Cookie-Header werden in JSON-Parse-Error-Logs redigiert.
- Die Beispiel-Secret-Denylist (`change-me…`) gilt beidseitig und fail-closed;
  Werte werden vor der Prüfung getrimmt.
- Der PlainTransport-Portbereich wird fail-closed gegen eine Überlappung mit
  dem RTC-Portbereich geschützt.
- Das Löschen von `keys.json` widerruft alle Stream-Keys; Rate-Limit und
  Eviction begrenzen fehlgeschlagene Authentifizierungsversuche.
- IPv4-mapped-Adressen werden normalisiert, Key-Prüfungen timing-uniform
  durchgeführt und Auth-Header redigiert; ein Strukturtest deckt die
  Redigierung ab.

Basis ist Upstream `mirotalkbro` v1.3.77 (Vendor-Import der vollen
Git-History, Remote `upstream`).
