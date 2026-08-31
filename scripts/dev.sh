#!/usr/bin/env bash
# ============================================================================
# scripts/dev.sh — Dev-Fast-Track (Hot Reload) für die RTMP-Spezialinstanz
#
# Zweck: Schnelle Feedback-Schleife am Arbeitsstand OHNE Commits und OHNE
# Docker-CLI auf dem Entwickler-Host. Das Repository wird einseitig
# (host→VM) per rsync nach /srv/mirotalk-bro-rtmp gespiegelt (rsync-synced
# folder im Vagrantfile) und dort auf der VM mit dem Hot-Reload-Override
# (docker-compose.dev-watch.yml: node --watch + read-only Bind-Mounts)
# gebaut und gestartet.
#
# Voraussetzungen:
#   * Host: vagrant + vagrant-libvirt + rsync. Ansible ist NICHT nötig —
#     nur für den E2E-Track (playbooks/dev_deploy.yml).
#   * VM: laufende Vagrant-VM (`vagrant up` wird idempotent sichergestellt)
#     inkl. rsync in der VM (im Debian-Box-Image enthalten).
#   * VM: Docker Engine + Compose-Plugin — installiert sie einmalig der
#     E2E-Track (playbooks/dev_deploy.yml); alternativ manuell in der VM
#     installieren (der Fast-Track selbst installiert nichts).
#   * VM: Secrets (.env, config/keys.json, certs/tls.{crt,key}) — bewusst
#     NICHT Teil des rsync-Syncs (rsync__exclude schützt sie auf der VM vor
#     --delete). Einmalig per `init` aus dem E2E-Track (/opt/mirotalkbro-rtmp)
#     übernehmen oder manuell erzeugen. Secret-WERTE werden nie ausgegeben,
#     nur Pfade.
#
# Workflow:
#   1. ./scripts/dev.sh init     (einmalig: Secrets auf die VM holen)
#   2. ./scripts/dev.sh up       (rsync + Compose-Stack mit Hot Reload)
#   3. Auf dem Host editieren; Änderungen mit `./scripts/dev.sh sync` oder
#      fortlaufend per `vagrant rsync-auto` auf die VM bringen — node
#      --watch startet die Prozesse danach automatisch neu.
#
# Wichtig: Der E2E-Track (playbooks/dev_deploy.yml) bleibt die Source of
# Truth für die vollständige Validierung des COMMITTETEN Standes. Dieser
# Fast-Track prüft bewusst nur den uncommitteten Arbeitsstand.
# ============================================================================
set -euo pipefail

# Identisch zu den Pfaden im Vagrantfile (rsync-Ziel) und in
# playbooks/dev_deploy.yml (E2E-Projektverzeichnis). Bewusst literal in den
# Remote-Skripten weiter unten gehalten (keine Shell-Splice-Risiken).
VM_DIR="/srv/mirotalk-bro-rtmp"
E2E_DIR="/opt/mirotalkbro-rtmp"
# Bewusst alle drei Dateien zusammen (siehe Header in docker-compose.yml):
# Basis + Dev-Bindings am privaten Vagrant-Netz + Hot-Reload-Override. Die
# Basis-Compose interpoliert BRO_INGEST_SECRET mit :? — deshalb braucht
# JEDE Compose-Operation (auch ps/logs/down) eine .env im VM-Projektverzeichnis.
COMPOSE_CMD="docker compose -f docker-compose.yml -f docker-compose.dev-override.yml -f docker-compose.dev-watch.yml"
# Container des Fast-Track-Projekts heißen mirotalk-bro-rtmp-<service>-<n>
# (Compose-Projektname = normalisierter Verzeichnisname von /srv/mirotalk-bro-rtmp).
OWN_CONTAINER_PREFIX="mirotalk-bro-rtmp-"
# Port-Kanarieren für die Konflikt-Erkennung gegen ANDERE Stacks (z. B. den
# E2E-Track in /opt/mirotalkbro-rtmp): BRO-Webport, öffentlicher RTMPS,
# Dev-Plain-RTMP und der erste Mediasoup-RTC-Port (Default-Bereich). Beide
# Tracks nutzen dieselben Ports und können nicht gleichzeitig laufen.
PORT_CONFLICT_RE=':(3016|1935|19350|40200)->'

usage() {
    cat <<'EOF'
Verwendung: ./scripts/dev.sh <Unterbefehl> [Argumente]

Dev-Fast-Track (Hot Reload) für die RTMP-Spezialinstanz: baut und startet
den Compose-Stack auf der Vagrant-VM aus dem rsync-synced Repository
(/srv/mirotalk-bro-rtmp) — ohne Commits und ohne Docker-CLI auf dem Host.

Unterbefehle:
  init                  Secrets einmalig auf die VM übernehmen (.env,
                        config/keys.json, certs/tls.{crt,key}) — aus dem
                        E2E-Track (/opt/mirotalkbro-rtmp), falls dort
                        vorhanden; andernfalls manuelle Anleitung. Vorhandene
                        Ziele werden nie überschrieben.
  up                    VM sicherstellen (vagrant up), rsync, Prüfungen
                        (Docker, Secrets, Port-Konflikte) und Start mit
                        --build
  build                 Images bauen (Cache nutzen)
  rebuild               Images ohne Cache neu bauen (--no-cache)
  down                  Fast-Track-Stack stoppen (E2E-Track in /opt bleibt
                        unberührt)
  restart               Fast-Track-Dienste neu starten
  ps                    Container-Status anzeigen
  logs [-f] [dienst]    Logs anzeigen; -f/--follow = folgen; dienst ∈
                        {bro, mediamtx, rtmp-adapter}
  sync                  Einmalig host→VM synchronisieren (vagrant rsync);
                        für Dauerbetrieb zusätzlich: vagrant rsync-auto
  shell                 Interaktive Shell auf der VM im Repo-Verzeichnis
                        (docker dort mit sudo — der vagrant-User ist nicht
                        in der docker-Gruppe)
  help                  Diese Hilfe (auch bei fehlendem Unterbefehl)

Beispiel:
  ./scripts/dev.sh init
  ./scripts/dev.sh up
  vagrant rsync-auto          # zweites Terminal: fortlaufend synchronisieren
  ./scripts/dev.sh logs -f bro

Hinweis: Der E2E-Track (playbooks/dev_deploy.yml) validiert den committeten
Stand vollständig und bleibt vor jeder Übergabe maßgeblich.
EOF
}

die() {
    printf 'Fehler: %s\n' "$1" >&2
    exit 1
}

# Befehl über `vagrant ssh -c` in der VM ausführen; der Remote-Exit-Code
# wird durchgereicht. Remote-Variablen in den Aufrufstrings sind bewusst
# als \$X escaped, Host-Werte kommen per Heredoc-Expansion hinein.
vm_run() {
    vagrant ssh -c "$1"
}

# VM sicherstellen — `vagrant up` ist idempotent (läuft die VM bereits,
# ist es ein schneller No-op ohne erneutes Provisioning).
ensure_vm() {
    vagrant up
}

ensure_docker_vm() {
    vm_run 'command -v docker >/dev/null 2>&1 || { echo DOCKER_FEHLT; exit 1; }' ||
        die "Docker ist auf der VM nicht installiert. Einmalig den E2E-Track deployen (ansible-playbook -i inventory/dev.yml playbooks/dev_deploy.yml — installiert Docker Engine + Compose-Plugin) oder Docker manuell in der VM installieren."
    vm_run 'sudo -n true 2>/dev/null || { echo SUDO_FEHLT; exit 1; }' ||
        die "Passwortloses sudo für den vagrant-Benutzer ist erforderlich (Standard bei debian/trixie64), da Docker auf der VM als root läuft."
}

# Auf der VM prüfen, ob die benötigten Secret-/Konfigurationsdateien im
# rsync-synced Repo liegen. Fehlt etwas: präzise Anleitung — es wird nichts
# automatisch kopiert (bewusst explizit: Unterbefehl init).
ensure_secrets_vm() {
    local remote out
    remote=$(cat <<EOF
m=""
for f in .env config/keys.json certs/tls.crt certs/tls.key; do
    [ -f "\$f" ] || m="\$m \$f"
done
[ -z "\$m" ] || { printf 'FEHLEN:%s\n' "\$m"; exit 1; }
EOF
)
    if out=$(vm_run "cd $VM_DIR && $remote"); then
        return 0
    fi
    printf '%s\n' "$out" >&2
    cat >&2 <<EOF
Für den Fast-Track fehlen auf der VM (in $VM_DIR): .env, config/keys.json, certs/tls.crt, certs/tls.key

Weg A (empfohlen, wenn der E2E-Track bereits deployt wurde):
    ./scripts/dev.sh init
    (übernimmt die Dateien aus $E2E_DIR auf die VM; überschreibt nichts)

Weg B (manuell in der VM erzeugen — vagrant ssh, dann):
    cd $VM_DIR
    cp .env.example .env
    # .env bearbeiten: mindestens BRO_INGEST_SECRET setzen
    cp config/keys.example.json config/keys.json
    # keyHash (SHA-256 des Stream-Tokens) eintragen, siehe docs/RTMP-INGEST.md Abschnitt 4
    mkdir -p certs
    openssl req -x509 -nodes -newkey rsa:4096 -days 3650 \\
        -keyout certs/tls.key -out certs/tls.crt \\
        -subj "/CN=mirotalkbro-rtmp-dev.test" \\
        -addext subjectAltName=DNS:mirotalkbro-rtmp-dev.test,IP:192.168.56.5 \\
        -addext basicConstraints=critical,CA:FALSE \\
        -addext keyUsage=critical,digitalSignature,keyEncipherment \\
        -addext extendedKeyUsage=serverAuth

Die Dateien sind von rsync ausgenommen (rsync__exclude im Vagrantfile) und
bleiben dauerhaft auf der VM liegen. Secret-Werte werden nie ausgegeben.
EOF
    die "Secrets/Konfiguration unvollständig — siehe Anleitung oben."
}

# Andere laufende Compose-Stacks (z. B. E2E-Track) erkennen, die bereits die
# Ports des Fast-Tracks belegen.
check_port_conflicts_vm() {
    local remote out
    remote=$(cat <<EOF
p="\$(sudo -n docker ps --format "{{.Names}} {{.Ports}}" | grep -Ev "^${OWN_CONTAINER_PREFIX}" || true)"
p="\$(printf '%s\n' "\$p" | grep -E '${PORT_CONFLICT_RE}' || true)"
[ -z "\$p" ] || { printf '%s\n' "\$p" | sed 's/^/PORT_KONFLIKT: /'; exit 1; }
EOF
)
    if out=$(vm_run "$remote"); then
        return 0
    fi
    printf '%s\n' "$out" >&2
    die "Ein anderer Stack belegt bereits die Ports des Fast-Tracks (3016/1935/19350 bzw. den RTC-Bereich) — vermutlich der E2E-Track. Erst dort herunterfahren: ansible-playbook -i inventory/dev.yml playbooks/dev_teardown.yml (oder in der VM: cd $E2E_DIR && sudo docker compose -f docker-compose.yml -f docker-compose.dev-override.yml down)."
}

# Gemeinsamer Vorlauf für alle Compose-Operationen: VM + Docker + Secrets.
compose_on_vm() {
    ensure_vm
    ensure_docker_vm
    ensure_secrets_vm
    vm_run "cd $VM_DIR && sudo -n $COMPOSE_CMD $*"
}

cmd_init() {
    ensure_vm
    vagrant rsync
    local remote out rc
    remote=$(cat <<EOF
if [ ! -f $E2E_DIR/.env ] && [ ! -d $E2E_DIR/.secrets ]; then
    echo E2E_FEHLT
    exit 2
fi
rc=0
copy_one() {
    rel="\$1"; mode="\$2"
    if [ ! -f "$E2E_DIR/\$rel" ]; then
        echo "QUELLE_FEHLT: $E2E_DIR/\$rel"
        rc=1
        return
    fi
    if [ -e "$VM_DIR/\$rel" ]; then
        echo "EXISTIERT_BEREITS: $VM_DIR/\$rel (übersprungen — zum Erneuern löschen und erneut ausführen)"
        return
    fi
    cp "$E2E_DIR/\$rel" "$VM_DIR/\$rel"
    chmod "\$mode" "$VM_DIR/\$rel"
    echo "KOPIERT: $E2E_DIR/\$rel -> $VM_DIR/\$rel (Modus \$mode)"
}
mkdir -p "$VM_DIR/config" "$VM_DIR/certs"
copy_one ".env" "0644"
copy_one "config/keys.json" "0644"
copy_one "certs/tls.crt" "0644"
copy_one "certs/tls.key" "0600"
exit "\$rc"
EOF
)
    if out=$(vm_run "$remote"); then
        printf '%s\n' "$out"
        printf '\nNächster Schritt: ./scripts/dev.sh up\n'
        return 0
    fi
    rc=$?
    printf '%s\n' "$out" >&2
    if [ "$rc" -eq 2 ]; then
        cat >&2 <<EOF
Der E2E-Track ist auf der VM noch nicht deployt ($E2E_DIR fehlt) und es gibt keine Quelle für den Secret-Transfer.

Weg A (empfohlen; installiert auch Docker in der VM), danach erneut ausführen:
    cp inventory/dev.yml.example inventory/dev.yml
    vagrant up
    ansible-playbook -i inventory/dev.yml playbooks/dev_deploy.yml
    ./scripts/dev.sh init

Weg B (manuell): .env, config/keys.json und certs/tls.{crt,key} direkt in $VM_DIR auf der VM erzeugen — siehe Anleitung bei ./scripts/dev.sh up.
EOF
        die "init: Keine E2E-Quelle gefunden."
    fi
    die "init: Nicht alle Dateien konnten aus $E2E_DIR übernommen werden — fehlende Quellen siehe oben (QUELLE_FEHLT); diese manuell ergänzen (Anleitung bei ./scripts/dev.sh up)."
}

cmd_up() {
    ensure_vm
    vagrant rsync
    ensure_docker_vm
    ensure_secrets_vm
    check_port_conflicts_vm
    vm_run "cd $VM_DIR && sudo -n $COMPOSE_CMD up -d --build"
    printf '\nFast-Track-Stack läuft (Hot Reload aktiv).\n  Viewer:         http://192.168.56.5:3016/viewer?id=devstudio&name=viewer\n  Synchronisieren: ./scripts/dev.sh sync  oder fortlaufend: vagrant rsync-auto\n  Logs:           ./scripts/dev.sh logs -f\n'
}

cmd_build() {
    compose_on_vm "build"
    printf '\nImages gebaut. Start bzw. Übernahme: ./scripts/dev.sh up\n'
}

cmd_rebuild() {
    compose_on_vm "build --no-cache"
    printf '\nImages ohne Cache neu gebaut. Übernahme in den laufenden Stack: ./scripts/dev.sh up\n  Hinweis: Abhängigkeits-, Dockerfile- und mediasoup-Änderungen sind NICHT hot-reloadbar.\n'
}

cmd_down() {
    compose_on_vm "down"
    printf '\nFast-Track-Stack gestoppt. Der E2E-Track in %s bleibt davon unberührt.\n' "$E2E_DIR"
}

cmd_restart() {
    compose_on_vm "restart"
}

cmd_ps() {
    compose_on_vm "ps"
}

cmd_logs() {
    local follow="" services="" arg
    for arg in "$@"; do
        case "$arg" in
            -f | --follow) follow="-f" ;;
            bro | mediamtx | rtmp-adapter) services="$services $arg" ;;
            *) die "Unbekanntes Argument für logs: $arg (erlaubt: -f bzw. --follow und bro, mediamtx, rtmp-adapter)" ;;
        esac
    done
    compose_on_vm "logs $follow $services"
}

cmd_sync() {
    ensure_vm
    vagrant rsync
    printf '\nSynchronisiert (host → VM). Für fortlaufende Synchronisation in einem\nzweiten Terminal ausführen: vagrant rsync-auto\n'
}

cmd_shell() {
    ensure_vm
    exec vagrant ssh -- -t "cd $VM_DIR && exec bash -l"
}

main() {
    local subcmd="${1:-help}"
    shift || true
    case "$subcmd" in
        init) cmd_init "$@" ;;
        up) cmd_up "$@" ;;
        build) cmd_build "$@" ;;
        rebuild) cmd_rebuild "$@" ;;
        down) cmd_down "$@" ;;
        restart) cmd_restart "$@" ;;
        ps) cmd_ps "$@" ;;
        logs) cmd_logs "$@" ;;
        sync) cmd_sync "$@" ;;
        shell) cmd_shell "$@" ;;
        help | -h | --help) usage ;;
        *)
            printf 'Unbekannter Unterbefehl: %s\n\n' "$subcmd" >&2
            usage >&2
            exit 1
            ;;
    esac
}

main "$@"
