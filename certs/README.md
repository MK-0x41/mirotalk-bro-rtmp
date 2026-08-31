# TLS-Zertifikate für MediaMTX (RTMPS)

Dieser Ordner enthält die TLS-Materialien für den öffentlichen RTMPS-Listener
(`rtmpsAddress: :1935`), gemountet nach `/etc/mediamtx/certs` im
mediamtx-Container.

Benötigte Dateien (Auslieferung passiert außerhalb dieses Repositories):

- `tls.crt` — Zertifikat (Kette)
- `tls.key` — privater Schlüssel

Quellen:

- **Development:** selbstsigniertes Zertifikat wird vom Vagrant-Dev-Playbook
  erzeugt (SPEC.md Abschnitt 11.2).
- **Produktion:** echtes Zertifikat (z. B. Let's Encrypt) stellt ein
  separater privater Installer bereit.

Private Schlüssel (`*.key`) niemals committen.
