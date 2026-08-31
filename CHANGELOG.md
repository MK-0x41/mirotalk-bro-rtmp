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
- Quellen-Auswahl im WebUI für Kamera, Bildschirm und RTMP; Bildschirm startet
  verzögert nach einer Browser-User-Geste, Kamera bleibt der Default.
- Per-Room-Stream-Keys über die administrativ geschützte Rooms-API (Create, Rotation,
  Delete); Klartext nur einmalig, Hash-at-Rest und Rate-Limiting.
- Dynamische Autorisierung des Adapters gegen die BRO-Registry; der statische
  `keys.json`-Fallback bleibt ausschließlich als Notfallmodus.
- `RTMP_REQUIRE_ROOM` bindet den Ingest an registrierte RTMP-Räume.
- Dev-Fast-Track mit rsync und `node --watch`, ohne Docker-CLI auf dem Host.
- E2E-Deploy mit echtem Per-Room-Key-Flow.
- Dev-Web über HTTPS mit selbstsigniertem Zertifikat (SAN für DNS und IP),
  persistent in `.secrets/` und damit Wipe-sicher.
- Copy-Buttons mit `execCommand`-Fallback, unabhängig vom Secure Context.
- Runbook-Abschnitt zu Dev-TLS einschließlich optionalem OBS-Truststore-Import.
- `sanitizeBody`-Redaktion in den globalen Request- und Fehler-Loggern.
- RTMP-Karte nur im SFU-Modus.
- Tests: 87 Root-Tests (`test/`, `npm run test:fork`) und 106 Adapter-Tests.
- `SPEC.md` und das RTMP-Runbook.

### Changed

- `.gitignore` trackt `docker-compose.yml`; Schlüssel, Zertifikate und
  Inventare bleiben ignoriert.
- `.env.template` enthält `EXTERNAL_INGEST_*` sowie den
  Ingest-Portbereich `41000–41099`.
- `package.json` enthält das Skript `test:fork`.

### Fixed

- E2E-Befund: Crash-Loop des rtmp-Adapters behoben (falscher Require-Pfad
  `./reconciler` → `./reconcile`); ein neuer statischer Require-Graph-Test
  sichert die Modulauflösung ab.
- E2E-Befund: Startup-Logging von BRO maskiert Secrets — `apiKeySecret` sowie
  (bei aktivem OIDC) `OIDC.config.clientSecret` und `OIDC.config.secret`
  (SESSION_SECRET) werden nur noch als
  `set`/`unset` geloggt (zuvor Klartext in `docker logs`).

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
- Die Rooms-API verweigert fehlende oder dokumentierte Default-
  `ADMIN_TOKEN`-Konfiguration fail-closed und begrenzt Fehlversuche pro IP.
- Stream-Keys werden in der Raum-Registry nur als SHA-256-Hashes gehalten;
  Klartext erscheint ausschließlich in Create- und Rotate-Antworten.

Basis ist Upstream `mirotalkbro` v1.3.77 (Vendor-Import der vollen
Git-History, Remote `upstream`).
