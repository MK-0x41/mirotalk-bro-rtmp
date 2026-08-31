# rtmp-adapter — Node.js >= 20, stdlib only, plus ffmpeg from apt
# Basisimage per sha256-Digest gepinnt (Unveränderlichkeit gegenüber
# Registry-Manipulation). Digest-Aktualisierung (Refresh):
#   TOKEN=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/node:pull" | jq -r .token)
#   curl -sI -H "Authorization: Bearer $TOKEN" \
#     -H "Accept: application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json" \
#     https://registry-1.docker.io/v2/library/node/manifests/24-slim \
#     | grep -i docker-content-digest
FROM node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e

# ffmpeg ohne Recommends (Bildgröße), danach apt-Cache aufräumen.
# ca-certificates für eventuelle https-Endpoints (BRO/MediaMTX sind intern
# plain http, aber der Adapter soll nicht an fehlenden Root-Certs scheitern).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Keine npm-Abhängigkeiten: nur Quelltext kopieren
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production

# Non-root: der "node"-User (uid 1000) ist im Basisimage vorhanden
USER node

EXPOSE 8080

CMD ["node", "src/index.js"]
