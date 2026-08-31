# SPEC: MiroTalk BRO RTMP-Spezialinstanz

Diese Spezifikation ist die maßgebliche Aufzeichnung der bisher getroffenen
technischen Entscheidungen für eine spezielle MiroTalk-BRO-Instanz mit
RTMP-Ingest.

## 1. Ausgangslage & Fragestellung

Der Nutzer installiert BRO derzeit über einen bestehenden, separaten (privaten,
nicht Teil dieses Forks) Ansible-Installer, der das Upstream-Image
`mirotalk/bro:latest` aus Docker Hub deployt.

Die Zielinstanz soll RTMP-Eingaben unterstützen. Die Frage „Customizing oder
Fork?“ wird wie folgt entschieden:

- Ein Fork ist erforderlich.
- Upstream-Version 1.3.77 enthält **kein RTMP**, keinen `PlainTransport`, kein
  WHIP und keine Plugin-/Hook-API.
- Alle Producer entstehen dort ausschließlich aus WebRTC-Browser-Clients.
- Eine Konfiguration allein kann daher keine externen Producer einschleusen.

Die gewählte Lösung ist ein minimaler Fork-Patch mit Sidecar-Architektur.
RTMP, Authentifizierung und FFmpeg laufen außerhalb des BRO-Prozesses.

Ausgangsbasis ist der Upstream-Fork von
[`mirotalkbro`](https://github.com/miroslavpejic85/mirotalkbro), lizenziert unter
AGPL-3.0, vendored bei Version 1.3.77 mit Commit
`d932edddf9cf04ac96a305af753ef27a021630db`. Das Upstream-Remote heißt
`upstream`.

## 2. Getroffene Entscheidungen

| Entscheidung | Wahl | Begründung |
| --- | --- | --- |
| Fork-Strategie | Vendor + Patch | Der vollständige Upstream-Import bleibt als Git-Historie über das Remote `upstream` erhalten. Eigene Commits liegen darauf. Upstream-Merges mit `git fetch upstream && git merge upstream/main` bleiben möglich. Upstream veröffentlicht keine Git-Tags; die Version wird über `package.json` verfolgt. |
| Image-Versorgung | Lokaler Build auf dem Zielhost durch Ansible | Der Installer baut mit `docker build` aus diesem Repository. Ein privates Registry ist nicht erforderlich. Die Anpassung erfolgt als Follow-up im Installer-Repository. |
| Host | Dedizierter Host | Dadurch entstehen keine Portkonflikte mit der bestehenden BRO-Instanz; die Ports 3016 und die RTC-Bereiche bleiben unverändert. |
| Stream-Key-Auth v1 | Statische Schlüssel, als SHA-256-Hashes in `keys.json` gespeichert; ein Schlüssel je `broadcastId` | Rotation erfolgt durch Dateibearbeitung und Adapter-Reload. Eine User-Datenbank ist in v1 nicht vorgesehen. |
| Lizenz | AGPL-3.0 anerkannt und akzeptiert | Der Fork-Quelltext wird veröffentlicht. |

## 3. Architektur

```text
OBS/Encoder
    │ RTMPS (öffentlich :1935)
    ▼
MediaMTX
    │ TLS-Terminierung, externe Authentifizierung
    │ RTMP intern (plain :19350)
    ▼
rtmp-adapter ── MediaMTX REST Polling ──► MediaMTX
    │ zieht RTMP intern
    ▼
FFmpeg-Transcoding
    │ H.264 Baseline 42e01f + Opus 48 kHz Stereo
    ▼
RTP
    │ getrennte RTP-/RTCP-Ports
    ▼
mediasoup PlainTransport (comedia)
    ▼
Producer in room.producers
    │ bestehendes BRO-Ereignis sfu-newProducer
    ▼
BRO-Viewer (unverändert)
```

MediaMTX nimmt den öffentlichen RTMPS-Stream entgegen, terminiert TLS und
führt die externe Publisher-Authentifizierung aus. Der `rtmp-adapter` zieht
den Stream über das interne Plain-RTMP, validiert den Stream-Key, verwaltet
FFmpeg-Prozesse und gleicht seinen Zustand mit MediaMTX ab. FFmpeg normalisiert
die Codecs und liefert RTP an BRO.

Der BRO-Patch stellt dafür einen externen Ingest bereit: Er erstellt je Stream
Video- und Audio-`PlainTransport`s sowie die zugehörigen Producer. Diese
Producer werden in `room.producers` eingetragen und über das bestehende
`sfu-newProducer`-Verhalten an Viewer verteilt. Die BRO-Viewer bleiben
unverändert.

| Komponente | Zuständigkeit |
| --- | --- |
| MediaMTX | RTMPS-Listener, Publisher-Authentifizierung, Path-Lifecycle |
| `rtmp-adapter` | Stream-Key-Validierung, FFmpeg-Prozessverwaltung, Zustandsabgleich durch Polling der MediaMTX-REST-API |
| FFmpeg | Codec-Normalisierung |
| BRO-Patch | `PlainTransport` und Producer für externen Ingest |
| BRO-Viewer | Unverändert vorhandene Anzeige und Wiedergabe |

## 4. BRO-Patch (externe Ingest-API)

### 4.1 Betroffene Dateien und Funktionen

Der Patch besteht aus:

- dem neuen Modul `app/external-ingest.js`,
- minimalem Wiring in `app/server.js`,
- Additionen in `app/mediasoup-handler.js` für
  `createExternalIngest`, `stopExternalIngest` und `status`,
- den ergänzten Konfigurationswerten in `.env.template` und den
  Ignore-Regeln in `.gitignore`.

### 4.2 HTTP-API

Die API ist ausschließlich intern über das Compose-Netzwerk erreichbar. Jede
Anfrage verwendet den Bearer-Token `EXTERNAL_INGEST_SECRET`. Der Vergleich
erfolgt constant-time. Die API arbeitet fail-closed, wenn das Secret nicht
gesetzt ist oder `EXTERNAL_INGEST_ENABLED` nicht exakt `true` ist.

| Methode und Pfad | Request | Antwort und Verhalten |
| --- | --- | --- |
| `POST /api/v1/external-ingest/start` | `{ "broadcastId": "…" }` | HTTP 200 mit `{ "broadcastId": "…", "video": { "port": …, "rtcpPort": …, "payloadType": …, "ssrc": … }, "audio": { "port": …, "rtcpPort": …, "payloadType": …, "ssrc": … } }`. Für dieselbe `broadcastId` idempotent. |
| `POST /api/v1/external-ingest/stop` | `{ "broadcastId": "…" }` | HTTP 200. Schließt Producer und Transports. Entfernt den Raum, wenn kein Viewer und kein Broadcaster verbleiben. |
| `GET /api/v1/external-ingest/status` | keiner | Liefert die aktiven Ingests. |

### 4.3 Raumzustand und Transportparameter

Der Raumzustand wird um folgenden Eintrag erweitert:

```text
externalIngest {
  active,
  videoTransport,
  audioTransport,
  videoProducer,
  audioProducer
}
```

Zusätzlich wird auf Raumebene der klebende Marker `hadExternalIngest` gesetzt,
sobald ein externer Ingest angelegt wurde. Die Grace-Logik für die Trennung des
Broadcasters darf einen Raum nicht entfernen, solange `externalIngest` aktiv
ist. Räume mit `hadExternalIngest` werden gelöscht, wenn der letzte Viewer
geht und weder Browser-Broadcaster noch Producer noch ein aktiver Ingest
verbleiben. Browser-only-Räume behalten dabei die Upstream-Semantik. Der Grace-Pfad setzt
bei aktivem externem Ingest `broadcasterSocketId` und `broadcasterTransport`
zurück und entfernt den Broadcaster-Viewer-Eintrag; der Raum bleibt für den
Ingest bestehen. Umgekehrt wird der Join eines Browser-Broadcasters in einen
Raum mit aktivem Ingest abgewiesen; damit ist die Exklusivitätsprüfung beidseitig.

Ein externer Ingest ist die exklusive Primärquelle eines Raums: `start` liefert
HTTP 409, wenn dort bereits ein Browser-Broadcaster oder ein Nicht-RTMP-Producer
vorhanden ist. Der idempotente Neustart eines bereits aktiven Ingests bleibt
zulässig.

Die Codec-Auswahl und Transportparameter für v1 sind:

- H.264 `42e01f` (Baseline) bevorzugt, Fallback `4d0032`.
- Opus mit 48 kHz und zwei Kanälen.
- `PlainTransport`: `listenInfo: { protocol: 'udp', ip: '0.0.0.0',
  portRange: { min: 41000, max: 41099 } }` und explizites
  `rtcpListenInfo: { protocol: 'udp', ip: '0.0.0.0',
  portRange: { min: 41000, max: 41099 } }`, da `rtcpMux: false`; `comedia: true`.
- Die Portspanne wird über `EXTERNAL_INGEST_PORT_MIN` und
  `EXTERNAL_INGEST_PORT_MAX` konfiguriert (Defaults `41000` und `41099`). Sie
  ist ausschließlich compose-intern, darf nie auf den Host veröffentlicht
  werden und darf sich nicht mit `MEDIASOUP_RTC_MIN_PORT` bis
  `MEDIASOUP_RTC_MAX_PORT` überschneiden. Eine Überlappung wird vor der
  Transporterzeugung fail-closed abgewiesen.
- Upstream setzt keine Worker-weiten RTC-Grenzen. Der WebRTC-Portbereich wird
  über die `listenInfos` des jeweiligen WebRTC-Transports festgelegt.
- SSRCs werden von BRO kryptografisch zufällig erzeugt und über die
  Start-Antwort zurückgegeben.

Ein JSON-Parse-Fehler in der HTTP-Middleware protokolliert Request-Header nur
redigiert: `authorization`, `cookie`, `x-api-key` und
`proxy-authorization` erscheinen als `[REDACTED]`. Die Beispielwerte
`change-me-generate-with-openssl-rand-hex-32` und
`changeme-changeme-changeme` bilden die case-insensitive
`EXAMPLE_SECRET_DENYLIST`; ihre Verwendung als Ingest-Secret wird mit einer
generischen HTTP-503-Antwort abgewiesen.

## 5. `rtmp-adapter`

Der Adapter ist ein Dienst auf Basis von `node:http` ohne Runtime-Abhängigkeiten
und benötigt Node.js 20 oder neuer.

### 5.1 HTTP-Endpunkte

- `POST /auth/publish` wird von MediaMTX als `externalAuthentication`
  verwendet. Der JSON-Body enthält `action`, `path` und `query`.
  - Verweigert wird u. a. Playback über MediaMTX sowie unbekannte Actions; die
    exakte Matrix wie unten.
  - Der Token wird mit SHA-256 gehasht und gegen `keys.json` geprüft.
  - Der Pfad muss dem Muster `/live/<broadcastId>` entsprechen.
  - Für Publisher sind nur die Protokolle `rtmp` und `rtmps` erlaubt. MediaMTX
    v1.20.1 meldet RTMPS-Publisher laut verifiziertem Quelltext in der
    Authentifizierung stets als `protocol=rtmp`; `rtmps` bleibt defensiv in der
    Allowlist.
  - `read`, `api`, `metrics` und `pprof` sind ausschließlich von den
    Adapter-eigenen IPs erlaubt. Das ist für den internen Pull und für
    `/v3/paths/list` erforderlich; externe Zugriffe werden abgewiesen.
  - Playback-Aktionen und nicht unterstützte Aktionen werden abgewiesen.
- `GET /healthz` dient dem Health Check.

### 5.2 Reconciliation und FFmpeg-Prozesse

Eine Reconciliation-Schleife fragt ungefähr alle zwei Sekunden
`/v3/paths/list` der MediaMTX-REST-API ab.

- Für jeden neuen bereiten Path wird die BRO-Start-API aufgerufen und FFmpeg
  gestartet.
- Bei Verlust eines Paths wird FFmpeg beendet (`SIGTERM`, danach `SIGKILL`),
  anschließend wird die BRO-Stop-API aufgerufen.
- FFmpeg-Abstürze werden mit Backoff neu gestartet.
- Fehlgeschlagene Authentifizierungsversuche werden im Speicher rate-limitiert;
  der Limiter ist auf 10000 Einträge begrenzt und evicted alte Einträge.
- `MAX_CONCURRENT_INGESTS` weist neue Ingests oberhalb des Limits fail-closed
  ab (Default: `4`).
- Nach einem BRO-Neustart wird für jeden laufenden Ingest mindestens alle 30
  Sekunden `GET /external-ingest/status` geprüft. Wird ein laufender Ingest
  dort positiv als fehlend erkannt, werden sein FFmpeg und Zustand abgebaut und
  mit neuen Ports und SSRCs frisch gestartet. Transiente Statusfehler reißen
  keinen laufenden Ingest ab.

Das Adapter-Kontrollsecret wird ausschließlich über Umgebungsvariablen
bereitgestellt; die Stream-Key-Hashes liegen in `keys.json`.

### 5.3 FFmpeg-Argumentvertrag

Für jede RTP-Ausgabe werden folgende Parameter verwendet:

```text
-payload_type <pt> -ssrc <ssrc> -f rtp
rtp://<broHost>:<rtpPort>?rtcp_port=<rtcpPort>
```

Video:

- `libx264`, Baseline, Level 3.1,
- `zerolatency`, `yuv420p`,
- GOP und `force_key_frames` auf zwei Sekunden,
- konfigurierbare Bitrate, Standard `2500k`.

Das zweisekündige Keyframe-Intervall dient der Keyframe-Wiederherstellung für
spät beitretende Viewer.

Audio:

- `libopus`, `128k`,
- 48 kHz, Stereo,
- `lowdelay`.

### 5.4 `keys.json`

Das Format ist:

```json
{
  "streams": {
    "<broadcastId>": {
      "keyHash": "<sha256hex>"
    }
  }
}
```

Das Löschen oder Unlesbarwerden von `keys.json` nach einem erfolgreichen Load
widerruft fail-closed alle Streams. Malformed JSON lässt dagegen den letzten
gültigen Stand bestehen; ein gültiges, leeres `streams`-Objekt widerruft alle
Streams. Der Key-Store ist prototype-sicher. Die Prüfung ist timing-uniform und
führt auch bei unbekanntem `broadcastId` einen Dummy-Hash-Vergleich aus.
IPv4-mapped-IPv6-Adressen werden normalisiert; der Resolver für lokale IPs
verwendet einen 5-Sekunden-Cache. Die zulässige SSRC-Spanne ist `1` bis
`0x7fffffff` und damit an BRO und FFmpeg angeglichen. Bei
`uncaughtException` erfolgt ein Graceful-Cleanup und anschließend der Exit mit
Status 1.

## 6. MediaMTX-Konfiguration

MediaMTX wird wie folgt konfiguriert:

- öffentlicher RTMPS-Listener auf `:1935` mit Zertifikat und Schlüssel,
- internes Plain-RTMP auf `:19350`, nur im Compose-Netzwerk; für den Adapter-
  Pull und für Development-Publishing,
- interne REST-API auf `:9997`,
- externe Authentifizierung:
  `http://rtmp-adapter:8080/auth/publish`,
- WebRTC, HLS, DASH und SRT sind deaktiviert,
- RTSP bleibt intern und verwendet den Standardport.

Das nutzerseitige Authentifizierungsmodell lautet:

```text
Server:     rtmps://<host>:1935/live
Stream key: <broadcastId>?token=<key>
```

Der Schlüssel ist das einzige Secret, das der Encoder speichert. Das Token
steht in der Query und darf niemals geloggt werden.

## 7. Container-Stack (`docker-compose.yml`)

Der Stack enthält folgende Services:

| Service | Build/Image und Ports |
| --- | --- |
| `bro` | Build aus dem Repository-Dockerfile; Host-Port 3016 nur auf Loopback; RTC-UDP-Bereich gemäß Installer |
| `mediamtx` | Digest-gepinntes `bluenviron/mediamtx:1.20.1@sha256:1b029d11049be75630e9b73bb0d5f47b08a7db4eaee89a80bf8f53bc40e56414`; `1935` öffentlich, `19350` und `9997` intern |
| `rtmp-adapter` | Build aus `rtmp-adapter/Dockerfile`; Digest-gepinntes `node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e` plus FFmpeg via `apt` |

`BRO_BASE_URL` wird in Compose als `http://bro:${PORT:-3016}` interpoliert.
Die Digest-Refresh-Rezepte stehen als Kommentare in den jeweiligen
Compose-/Dockerfile-Dateien.

Die getrackte `docker-compose.dev-override.yml` ergänzt ausschließlich für die
Entwicklung Bindings am privaten Vagrant-Netz: BRO auf
`${DEV_BIND_IP:-192.168.56.5}:3016` und MediaMTX auf
`${DEV_BIND_IP:-192.168.56.5}:19350`. Diese Override-Datei ist ausdrücklich
nicht für Produktion bestimmt. Die Basis-Compose-Datei bindet den BRO-Web-Port
weiterhin nur an Loopback und veröffentlicht nur die dort ausdrücklich
vorgesehenen Produktions- und SFU-Ports.

Alle Services liegen in einem internen Compose-Netzwerk. Die RTP-Flows des
`PlainTransport` gehen ausschließlich vom Adapter zu BRO innerhalb dieses
Netzwerks.

TLS für die Web-Oberfläche bleibt der Host-Nginx-Aufgabe im Installer-
Repository vorbehalten und ist nicht Teil dieses Compose-Stacks.

## 8. Codecs

RTMP liefert typischerweise H.264 und AAC. AAC ist nicht in den BRO-Router-
Codecs enthalten und wird deshalb nach Opus transkodiert.

Für v1 wird Video zur besseren Vorhersagbarkeit auf H.264 Baseline normiert.
Eine Optimierung durch Stream-Copy ist ein Follow-up und nur zulässig, wenn die
Parameter kompatibel sind.

## 9. v1-Nicht-Ziele

Folgende Funktionen sind ausdrücklich nicht Bestandteil von v1:

- Mischung von Kamera und RTMP; pro Raum gibt es genau eine primäre Quelle:
  Browser-Broadcaster **oder** RTMP-Ingest.
- Mehr als ein aktiver RTMP-Publisher je `broadcastId`.
- User-Datenbank oder OIDC-gebundene Schlüsselverwaltung.
- UI für Schlüsselrotation.
- WHIP, WHEP oder SRT.
- HLS-Fallback.
- Eigenes Nginx-RTMP-Modul.
- Ingest im P2P-Modus; unterstützt wird ausschließlich SFU.

## 10. Ports

| Port | Protokoll | Zweck | Sichtbarkeit |
| --- | --- | --- | --- |
| 3016 | TCP | Web | Host-seitig Loopback; in Produktion hinter Nginx |
| 40200–40300 | UDP/TCP | Mediasoup-RTC | Öffentlich, SFU |
| 1935 | TCP | RTMPS | Öffentlich, **neu** |
| 19350 | TCP | Internes RTMP | Nur Compose-Netzwerk; Dev-Override-Binding am Vagrant-Netz |
| 9997 | TCP | MediaMTX-REST | Nur Compose-Netzwerk |
| 8080 | TCP | Adapter-Authentifizierung | Nur Compose-Netzwerk |
| 41000–41099 | UDP | PlainTransport-Ingest | Compose-intern, **nie** host-publiziert; darf den RTC-Bereich nicht überlappen |

## 11. Dev-Umgebung (Vagrant)

Die Vagrant-Umgebung folgt einem bewährten lokalen Dev-VM-Muster (libvirt-only,
Debian/trixie64, strikt validierter Root-SSH-Key-Bootstrap,
Umgebungsvariablen-Overrides):

- Debian `trixie64`,
- ausschließlich libvirt,
- Vagrant-libvirt-Plugin,
- deaktivierte `/vagrant`-Synchronisation,
- Bootstrap des Root-SSH-Schlüssels über validierte öffentliche Schlüssel mit
  Marker-Block und `sshd`-Drop-in,
- per `MIROTALKBRO_RTMP_DEV_*` überschreibbare Variablen.

### 11.1 VM-Parameter und Netzwerke

| Parameter | Festlegung |
| --- | --- |
| Hostname | `mirotalkbro-rtmp-dev` |
| IP | `192.168.56.5` |
| Management-Netz | `192.168.121.0/24` für Ansible nach optionaler Host-Härtung |
| RAM / CPU | 4096 MB / 2 vCPU |

`.5` wurde als freier Nachbar der BRO-VM `.4` und der SFU-VM `.3` gewählt.

### 11.2 Deployment

`playbooks/dev_deploy.yml` installiert Docker, wobei das Setup des Installers
(`setup_docker`) gespiegelt wird. Danach werden folgende Schritte ausgeführt:

1. Das Projektverzeichnis vor jedem Deploy leeren; `.secrets` bleibt erhalten.
2. Repository als Git-Archive-Tarball mit Ansible `copy` übertragen und mit
   `unarchive` entpacken.
3. Verzeichnisse anlegen, Secrets erzeugen und den Hash über die exakten
   Token-Bytes bilden. Secrets werden newline-frei mit `printf %s` persistiert
   und per atomarem `mv` ersetzt.
4. Selbstsigniertes RTMPS-Zertifikat erzeugen.
5. `keys.json` mit dem bekannten Development-Schlüssel rendern.
6. `.env` rendern.
7. `docker compose -f docker-compose.yml -f docker-compose.dev-override.yml
   build` ausführen.
8. Anschließend `docker compose -f docker-compose.yml
   -f docker-compose.dev-override.yml up -d` ausführen.

Der Dev-Zugriff erfolgt über `http://192.168.56.5:3016`. Dies ist absichtlich
Plain-HTTP für Development; TLS-Terminierung durch Nginx ist ein
Produktionsaspekt.

Zum Testen kann über das interne RTMP auf `192.168.56.5:19350` publiziert
werden. Für automatisierte Tests ist dieser Weg zu verwenden, da ein
selbstsigniertes RTMPS-Zertifikat in OBS manuell als vertrauenswürdig
eingestuft werden muss. Der FFmpeg-Test-One-Liner lautet:

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=440 -c:v libx264 -preset veryfast \
  -tune zerolatency -pix_fmt yuv420p -c:a aac -ar 48000 -f flv \
  'rtmp://192.168.56.5:19350/live/<id>?token=$(cat .secrets/dev-stream-key.txt)'
```

Optional kann vor `dev_deploy` eine eigene Host-Hardening-Baseline angewendet
werden; danach ist das Dev-Inventar entsprechend anzupassen (gehärteter
Benutzer/SSH-Port).

## 12. Upstream-Merge-Strategie

Der Vendor-Import bleibt als echte Git-Historie erhalten. Patches werden klein
und isoliert gehalten:

- neue Datei `app/external-ingest.js`,
- wenige Zeilen Wiring in `app/server.js`,
- additive Funktionen in `app/mediasoup-handler.js`,
- die erforderlichen Ergänzungen in `.env.template` und `.gitignore`.

Der Merge-Ablauf lautet:

```bash
git fetch upstream && git merge upstream/main
```

Konflikte in den gepatchten Dateien werden manuell aufgelöst. Da Upstream
keine Tags veröffentlicht, erfolgt die Versionsverfolgung über `package.json`.

## 13. Lizenz & Veröffentlichung

Das Projekt steht unter AGPL-3.0. Weil der Fork Nutzer über ein Netzwerk
bedient, muss der modifizierte Quelltext veröffentlicht werden; dies geschieht
über dieses Repository.

Die Upstream-Datei `LICENSE` bleibt unverändert. Das Fork-README muss auf
Upstream verweisen und die vorgenommenen Änderungen benennen.

### Öffentliche Spiegelung

- Dieses Repository ist für eine öffentliche Spiegelung unter AGPL-3.0 ausgelegt.
- Dokumentation und Konfiguration dürfen keine Verweise auf private Infrastruktur enthalten.
- Vor der Veröffentlichung ist per `grep` nach privaten Identifikatoren zu suchen.
- Der produktive Ansible-Installer bleibt privat und wird hier ausschließlich generisch referenziert.

## 14. Sicherheit

- Öffentlicher Ingest ist ausschließlich über RTMPS erlaubt.
- Stream-Keys werden nur als Hashes gespeichert.
- Schlüsselvergleiche erfolgen constant-time.
- Die interne API mit Bearer-Secret arbeitet fail-closed.
- Die Beispiel-Secret-Denylist gilt beidseitig für BRO-Router und
  Adapter-Konfiguration; Treffer werden fail-closed abgewiesen.
- Für Produktion gilt ein Nginx-Vertrag: Der Reverse-Proxy MUSS
  `/api/v1/external-ingest` extern blockieren und `9997`, `8080`, `19350` sowie
  `41000–41099` dürfen niemals exponiert werden. Auf dem gemeinsamen
  Express-App-Port ist der Bearer die einzige Kontrollebene; das ist ein
  dokumentiertes Restrisiko und erfordert ein Follow-up im Installer.
- `keys.json` verwendet ungesalzenes SHA-256. Stream-Tokens müssen deshalb
  hoch-entropisch sein, mindestens nach dem Muster
  `openssl rand -hex 32` (256 Bit).
- Die Compose-Bridge ist Layer 2: Ein kompromittierter Sibling-Container
  könnte die Adapter-IP spoofen. Dieses Restrisiko ist dokumentiert.
- `.env` ist in Dev wegen des Container-UID-1000-Trade-offs `0644`; in
  Produktion sind `0640` mit root und passender Gruppe oder Docker-Secrets zu
  verwenden.
- Die Ports `19350`, `9997` und `8080` werden niemals auf den Host
  veröffentlicht.
- Stream-Keys und Tokens werden in Logs redigiert. Insbesondere dürfen weder
  der Adapter noch das SPEC-Runbook Query-Strings protokollieren.
- Der Authentifizierungsendpunkt ist rate-limitiert.
- Je Path ist genau ein Publisher erlaubt.
- FFmpeg-Argumente haben eine feste Form. Benutzereingaben gelangen nicht in
  eine Shell; `child_process.spawn` wird ausschließlich mit einem
  Argument-Array verwendet.

## 15. Validierung

Folgende Prüfungen sind vorgesehen:

- Unit-Tests für `rtmp-adapter` mit `node:test` für Authentifizierung,
  Argument-Builder und Reconciler mit Mocks,
- `node --check` für alle geänderten JavaScript-Dateien,
- `ruby -c Vagrantfile`,
- `vagrant validate`,
- `yamllint`,
- `ansible-playbook --syntax-check dev_deploy.yml`,
- manueller End-to-End-Test in der Vagrant-VM gemäß Runbook-Schritt:
  FFmpeg-Testquelle bis zum Viewer.

Die vollständige Integration des Installers ist Phase 5 und erfolgt in einem
separaten (privaten) Installer-Repository. Dort ist RTMP derzeit explizit als
Nicht-Ziel deklariert; die Integration ist als Follow-up vorgesehen:

- Revision der SPEC dort (RTMP war in `SPEC.md:37` ein explizites Nicht-Ziel),
- neue Inventory-Variablen,
- Ergänzungen der Compose-Services,
- UFW-Regel für `1935/tcp`,
- Task für den lokalen Image-Build,
- Pin-Updates in `static_scaffold.sh`.

Diese Installer-Integration ist **nicht** Bestandteil dieses Repositories.

## 16. Abnahmekriterien v1

1. OBS oder FFmpeg kann mit einem gültigen Schlüssel über RTMPS publizieren;
   Viewer im BRO-Web-Viewer sehen und hören Audio/Video innerhalb von etwa
   fünf Sekunden.
2. Ein ungültiger, abgelaufener oder zum falschen Path gehörender Schlüssel
   wird mit HTTP 401 oder 403 abgewiesen.
3. Beim Stream-Ende werden die Producer geschlossen, Viewer erhalten das
   Producer-Closed-Signal und der Raum wird bereinigt.
4. Nach einem BRO-Neustart re-attacht der Adapter innerhalb von etwa zwei
   Zyklen (≈4–65 s) mit frischen Ports und SSRCs; es existieren keine
   verwaisten Ports.
5. Ein spät beitretender Viewer erhält Video; ein Keyframe steht innerhalb
   von höchstens zwei Sekunden zur Verfügung.
6. Kein Secret erscheint in irgendeinem Log.
7. Die angefassten Upstream-Dateien sind ausschließlich
   `app/mediasoup-handler.js`, `app/server.js` (einschließlich einer
   sicherheitsrelevanten Log-Zeile), `.env.template` und `.gitignore`.
8. Alle in Abschnitt 15 aufgeführten Validierungsbefehle sind erfolgreich.
