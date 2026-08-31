# Stream-Keys für den rtmp-adapter

Der rtmp-adapter liest `config/keys.json` (gemountet nach
`/app/config/keys.json`, read-only) beim Start und im 5-Sekunden-Polling für
Hot-Reloads. Format siehe `keys.example.json`:

```json
{
    "streams": {
        "<broadcastId>": { "keyHash": "<sha256(token) als 64 Hex-Zeichen>" }
    }
}
```

- Encoder veröffentlicht zu `rtmps://<host>:1935/live` mit dem Stream-Key
  `<broadcastId>?token=<streamKey>`.
- Rotation: Datei bearbeiten — der Adapter übernimmt Änderungen automatisch
  (fehlerhafte Dateien verändern den letzten gültigen Zustand nicht).
- `config/keys.json` enthält Hashes, aber die Datei selbst NIEMALS committen;
  die echte Datei erzeugt der Installer bzw. das Dev-Playbook.
