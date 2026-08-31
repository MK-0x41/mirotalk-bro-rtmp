# RTMP-Ingest-Runbook

Dieses Runbook beschreibt den öffentlichen, reproduzierbaren Dev-Ablauf für
den RTMP-Fork von MiroTalk BRO. Produktionsbetrieb erfordert zusätzlich den
im Abschnitt [Produktions-Contract](#6-produktions-contract-installer)
beschriebenen Reverse-Proxy- und Host-Sicherheitsvertrag.

## 1. Überblick

Der RTMP-Ingest bleibt für BRO-Viewer transparent: Ein OBS- oder Encoder-Stream
wird von MediaMTX angenommen, vom Adapter mit FFmpeg normalisiert und als RTP
in mediasoup eingespeist. Die Viewer verwenden weiterhin die normale BRO-
Wiedergabe.

```text
OBS/Encoder
    │ RTMPS :1935
    ▼
MediaMTX ── REST :9997 (intern) ── rtmp-adapter :8080 (intern)
    │ internes RTMP :19350
    ▼
rtmp-adapter ── FFmpeg ── H.264 + Opus RTP
                              │ UDP :41000–41099 (intern)
                              ▼
                    mediasoup PlainTransport → BRO-SFU → Viewer
```

Komponenten:

- **MediaMTX** terminiert RTMPS, authentifiziert Publisher über den Adapter und
  verwaltet den Path-Lifecycle. Der Container ist auf v1.20.1 per Digest
  gepinnt.
- **`rtmp-adapter`** prüft Stream-Keys, reconciliert MediaMTX-Paths, startet
  und beendet FFmpeg und hängt laufende Streams nach einem BRO-Neustart erneut
  an.
- **FFmpeg** erzeugt aus der RTMP-Quelle H.264-Baseline- und Opus-RTP mit
  regelmäßigen Keyframes.
- **BRO** legt die externen Video- und Audio-Producer in einem exklusiven SFU-
  Raum an; vorhandene Viewer bleiben unverändert.

Portübersicht:

| Port | Zweck | Erreichbarkeit |
| ---: | --- | --- |
| `1935/tcp` | Öffentliches RTMPS für Encoder | Produktions-Reverse-Proxy bzw. Host |
| `3016/tcp` | BRO-Weboberfläche und API | Dev-Binding; Produktion über Reverse-Proxy |
| `19350/tcp` | Internes Plain-RTMP zwischen MediaMTX und Adapter | Compose-intern; Dev zusätzlich am privaten Vagrant-Netz |
| `9997/tcp` | MediaMTX-REST-API | Nur Compose-intern |
| `8080/tcp` | Adapter-Auth- und Health-Endpunkt | Nur Compose-intern |
| `41000–41099/udp` | RTP/RTCP für PlainTransports | Nur Compose-intern; **niemals auf dem Host veröffentlichen** |

Der Portbereich `41000–41099` darf sich nicht mit dem konfigurierten mediasoup-
RTC-Bereich überschneiden. Alle nicht ausdrücklich benötigten Control- und
Medienports bleiben intern.

## 2. Dev-Umgebung (Vagrant)

### Voraussetzungen

- Vagrant
- `vagrant-libvirt`
- Ansible
- Eine lokale SSH-Public-Key-Datei für den Vagrant-Bootstrap
- Für den lokalen Stack: Docker Engine und Docker Compose Plugin in der VM
  (werden vom Playbook installiert)

### Bereitstellen

Im Repository-Verzeichnis:

```bash
cp inventory/dev.yml.example inventory/dev.yml
vagrant up
ansible-playbook -i inventory/dev.yml playbooks/dev_deploy.yml
```

Die Beispielkonfiguration verwendet `debian/trixie64`, libvirt und die private
Vagrant-Adresse `192.168.56.5`. Vor `dev_deploy` kann optional eine eigene
Host-Härtung angewendet werden; danach sind Benutzer, SSH-Port und gegebenen-
falls die Bind-Adresse im Inventar anzupassen. Das Playbook erwartet einen
committeten, sauberen Arbeitsstand, weil es `git archive HEAD` überträgt.

Nach erfolgreichem Deployment:

- Viewer: <http://192.168.56.5:3016/viewer?id=devstudio&name=viewer>
- Dev-Stream-Key in der VM:
  `/opt/mirotalkbro-rtmp/.secrets/dev-stream-key.txt`
- Interner FFmpeg-Testpublish (in der VM oder von einem erreichbaren Dev-Host):

  ```bash
  ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -c:a aac -ar 48000 -f flv "rtmp://192.168.56.5:19350/live/devstudio?token=$(cat /opt/mirotalkbro-rtmp/.secrets/dev-stream-key.txt)"
  ```

Für einen RTMPS-Test kann OBS den Server
`rtmps://192.168.56.5:1935/live` verwenden. Das Dev-Zertifikat ist selbst-
signiert; OBS oder der Testclient muss es explizit akzeptieren. Für auto-
matisierte Prüfungen ist der interne Plain-RTMP-Test oben vorzuziehen. In
Produktion ausschließlich RTMPS verwenden.

### Teardown

Den Compose-Stack herunterfahren:

```bash
ansible-playbook -i inventory/dev.yml playbooks/dev_teardown.yml
```

Standardmäßig bleiben Projektverzeichnis, Images, Volumes und Dev-Secrets für
ein schnelles Re-Deployment erhalten. Für eine vollständige lokale Entfernung
können die im Playbook dokumentierten Opt-in-Variablen verwendet werden; die
VM selbst wird mit `vagrant destroy -f` entfernt.

## 3. E2E-Prüfliste

Die folgenden Kriterien gelten für den VM-only-E2E-Test:

- [ ] Gültiger OBS- oder FFmpeg-Publish liefert Audio und Video innerhalb von
      etwa fünf Sekunden im BRO-Viewer.
- [ ] Ein spät beitretender Viewer erhält innerhalb von höchstens zwei Sekunden
      ein Video-Keyframe.
- [ ] Ein falscher, abgelaufener oder einem anderen Path zugehöriger Key wird
      mit HTTP 401 oder 403 abgewiesen.
- [ ] Beim Stream-Ende werden die Producer geschlossen (`producerClosed`) und
      der Raum wird sowohl mit als auch ohne verbleibenden Viewer korrekt
      bereinigt.
- [ ] Nach einem BRO-Neustart führt der Adapter ein Reattach mit frischen
      Ports und SSRCs aus; es bleiben keine verwaisten Ports zurück.
- [ ] Stream-Keys, Bearer-Secrets, Query-Strings und andere Secrets erscheinen
      in keinem Log.

## 4. Stream-Keys verwalten

Stream-Keys werden nicht im Klartext gespeichert. Erzeuge einen hochentropischen
Token und berechne dessen ungesalzenen SHA-256-Hash:

```bash
TOKEN="$(openssl rand -hex 32)"
printf '%s\n' "$TOKEN"
node -e "console.log(require('crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" "$TOKEN"
```

Der Hash wird in `config/keys.json` eingetragen:

```json
{
  "_comment": "optional; wird ignoriert",
  "streams": {
    "devstudio": {
      "keyHash": "<64-stellige-sha256-hexadezimalzahl>"
    }
  }
}
```

Das `_comment`-Feld und unbekannte Zusatzfelder werden ignoriert. Der Adapter
liest die Datei beim Start und lädt Änderungen ungefähr alle fünf Sekunden
neu. Ungültiges JSON hält den letzten gültigen Stand; eine gelöschte oder
unlesbare Datei widerruft nach einem erfolgreichen Load alle Keys fail-closed.
Ein gültiges leeres `streams`-Objekt widerruft ebenfalls alle Streams.

Tokens müssen hochentropisch sein, mindestens nach dem Muster
`openssl rand -hex 32`, weil die Ablage ungesalzene SHA-256-Hashes verwendet.
`config/keys.json` darf niemals mit echten Keys in das Repository gelangen.

## 5. OBS/Encoder einrichten

Für Produktion:

- Server: `rtmps://<host>:1935/live`
- Stream-Key: `<broadcastId>?token=<TOKEN>`

In OBS wird die URL als Server und der zusammengesetzte Wert als Stream-Key
eingetragen; bei Encodern gelten dieselben Path- und Query-Bestandteile. In
Produktion ist ausschließlich RTMPS zulässig. Der Stream-Key muss zu genau dem
`broadcastId`-Path passen.

Pro Raum ist genau ein aktiver Publisher vorgesehen. Ein RTMP-Ingest ist die
exklusive Primärquelle: Ein Raum mit Browser-Broadcaster oder anderem
Nicht-RTMP-Producer wird abgewiesen, und ein Browser-Broadcaster kann einem
aktiven RTMP-Ingest nicht beitreten.

## 6. Produktions-Contract (Installer)

Der separate Produktions-Installer muss mindestens Folgendes sicherstellen:

- Der Reverse-Proxy **MUSS** `/api/v1/external-ingest` extern blockieren. Die
  Route ist nur für den internen Adapter-Aufruf vorgesehen.
- `9997`, `8080`, `19350` und `41000–41099` dürfen niemals exponiert werden.
  Insbesondere darf der PlainTransport-Portbereich nicht auf dem Host
  veröffentlicht werden.
- `.env` muss mit Modus `0640` und Eigentümer `root` sowie einer passenden
  Gruppe betrieben werden; `0644` ist für Produktion nicht ausreichend.
- Das RTMPS-Zertifikat muss von einer vertrauenswürdigen Quelle wie Certbot
  oder einer vergleichbaren ACME-/Zertifikatsverwaltung stammen. Selbst-
  signierte Zertifikate sind nur für Development geeignet.

Bekannte Restrisiken:

- Das Compose-Bridge-Netz ist Layer 2; ein kompromittierter Sibling-Container
  könnte die Adapter-IP spoofen.
- Auf dem gemeinsamen App-Port ist der Bearer das einzige Kontrollmerkmal.
  Deshalb muss die Ingest-API zusätzlich am Reverse-Proxy blockiert werden.

Die Integration des separaten Installers ist nicht Bestandteil dieses
Repositories.

## 7. Fehlersuche

### Adapter-Logs

Die Adapter-Logs bestehen aus JSON-Zeilen. Sie enthalten nur für die Diagnose
notwendige Metadaten wie IP, Path, Aktion und Entscheidung; Tokens, Query-
Strings, Passwörter und Auth-Header werden nie protokolliert.

### Statusabfrage

Die Statusroute ist nur intern und mit dem Bearer-Secret erreichbar:

```bash
curl -H "Authorization: Bearer $BRO_INGEST_SECRET" \
  http://127.0.0.1:3016/api/v1/external-ingest/status
```

Das Secret nicht in Shell-History, Tickets oder Logs übernehmen. Bei einem
Zugriff aus dem Adapter-Container ist dessen interne BRO-Adresse statt
`127.0.0.1` zu verwenden.

### Häufige Ursachen

- **401 trotz gültigem Token:** Path muss `live/<broadcastId>` entsprechen;
  außerdem `config/keys.json`, `keyHash` und den geladenen Key prüfen. Ein
  fehlender, unlesbarer oder gelöschter Key-Store widerruft alle Streams.
- **Ingest startet nicht:** Überlappung zwischen `41000–41099` und dem
  mediasoup-RTC-Portbereich führt absichtlich zu einer fail-closed-Ablehnung.
- **Video oder Audio fehlt:** Prüfen, ob der Encoder beide Spuren liefert und
  FFmpeg die erwarteten Codecs erzeugt.
- **Producer bleibt aus oder wird geschlossen:** RTP- und RTCP-Port müssen
  erreichbar sein; fehlendes RTCP, insbesondere bei deaktiviertem RTCP-Mux,
  verhindert einen stabilen PlainTransport.
- **Stream verschwindet nach BRO-Neustart:** Adapter-Reconciler und BRO-Status-
  endpoint prüfen; ein positiver Statusfehler wird nicht als Ausfall gewertet,
  ein bestätigtes Fehlen löst Reattach mit neuen Ports und SSRCs aus.
