#!/usr/bin/env bash
# Install (or update) pear-server on a Debian/Ubuntu machine — a VM, an LXC
# container, a Raspberry Pi. Run as root:
#
#   curl -fsSL https://raw.githubusercontent.com/dmytro-kryvyi/pear-ssh/main/server/install.sh | bash
#
# Behind your own reverse proxy on another machine (Caddy, nginx, Traefik):
#
#   curl -fsSL …/server/install.sh | bash -s -- \
#     --public-url https://pear.example.com --host 0.0.0.0 --trusted-proxy <proxy ip>
#
# The installer sets up Pear and nothing else: HTTPS and who-may-connect are
# your infrastructure's job (reverse proxy, VPN, Tailscale) — docs/SERVER.md.
#
# Running it again updates in place; hosts, keys and logins are kept.
# Everything it does is listed by --help. Details: docs/SERVER.md.
set -euo pipefail

REPO="dmytro-kryvyi/pear-ssh"
PREFIX="/opt/pear-server"
ENV_FILE="/etc/pear-server.env"
UNIT="/etc/systemd/system/pear-server.service"
UPDATE_UNIT="/etc/systemd/system/pear-server-update"   # .service / .timer
SELF="/usr/local/lib/pear-server/install.sh"
NODE_MAJOR=22
# Overridable so a fork, a mirror or a test can stand in for GitHub.
DOWNLOAD_BASE="${PEAR_DOWNLOAD_BASE:-https://github.com/$REPO/releases}"

RUN_USER="pear"
PORT=""
AUTH=""
PUBLIC_URL=""
VERSION="latest"
BUNDLE=""
HOST=""
TRUSTED_PROXIES=()
SERVICE=1
LOCAL_HOST=0
UNINSTALL=0
IF_NEWER=0
WHEN_IDLE=0
AUTO_UPDATE=""   # "", on, off — empty keeps whatever is set up already

usage() {
  cat <<'EOF'
pear-server installer

  --public-url <url>    The address people will open (https://pear.example.com)
  --host <addr>         Address to listen on (default 127.0.0.1). Use 0.0.0.0 or
                        this machine's LAN address when the reverse proxy runs
                        on a different machine.
  --trusted-proxy <ip>  That proxy's address (or a CIDR; repeatable): whose
                        X-Forwarded-For to believe, so login throttling sees
                        real clients. Not needed for a proxy on this machine.
  --auth <mode>         password (default) | proxy | none   — see docs/SERVER.md
  --port <n>            Local port (default 7327)
  --user <name>         System user that runs Pear (default: pear). Shells on
                        "this computer" and the Claude CLI run as this user.
  --enable-local-host   Offer the server machine itself as a host
  --version <tag>       Release to install (default: latest), e.g. v0.2.0
  --bundle <file|url>   Install this pear-server.tar.gz instead of a release
  --no-service          Install only; don't create or start the systemd service

Updating — running the installer again IS the update (data and settings are kept):
  --auto-update         Check daily and update by itself — but only while nothing
                        is running on the server (no open terminals, no Claude
                        turn): a restart would end them. Busy → tries again next day.
  --no-auto-update      Turn that off again
  --if-newer            Do nothing unless a newer release than the installed one exists
  --when-idle           Do nothing while terminals or a Claude turn are running
  --uninstall           Remove the program and service. Data is kept.
  -h, --help

What it does: installs Node.js 22 if missing, creates the system user, unpacks a
prebuilt bundle into /opt/pear-server, installs its runtime packages, writes
/etc/pear-server.env and a systemd service, starts it, and — on a first install
with password auth — prints the generated password once.
EOF
}

say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift ;;
    --trusted-proxy) TRUSTED_PROXIES+=("${2:?--trusted-proxy needs a value}"); shift ;;
    --public-url) PUBLIC_URL="${2:?--public-url needs a value}"; shift ;;
    --auth) AUTH="${2:?--auth needs a value}"; shift ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --user) RUN_USER="${2:?--user needs a value}"; shift ;;
    --enable-local-host) LOCAL_HOST=1 ;;
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --bundle) BUNDLE="${2:?--bundle needs a value}"; shift ;;
    --no-service) SERVICE=0 ;;
    --auto-update) AUTO_UPDATE=on ;;
    --no-auto-update) AUTO_UPDATE=off ;;
    --if-newer) IF_NEWER=1 ;;
    --when-idle) WHEN_IDLE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "Run as root (try: sudo bash install.sh)"
case "$AUTH" in ""|password|proxy|none) ;; *) die "--auth must be password, proxy or none" ;; esac

have_systemd() { [ -d /run/systemd/system ]; }

if [ "$UNINSTALL" = 1 ]; then
  if have_systemd && [ -f "$UNIT" ]; then
    systemctl disable --now pear-server >/dev/null 2>&1 || true
    systemctl disable --now pear-server-update.timer >/dev/null 2>&1 || true
    rm -f "$UNIT" "$UPDATE_UNIT.service" "$UPDATE_UNIT.timer"; systemctl daemon-reload
  fi
  rm -rf "$PREFIX" "$ENV_FILE" "$(dirname "$SELF")"
  say "Removed. Your data is still in ~$RUN_USER/.local/share/pear-server and ~$RUN_USER/.config/pear-server"
  exit 0
fi

# ---- update guards (cheap, before anything is touched) ---------------------------
installed_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$PREFIX/package.json" 2>/dev/null | head -1; }
# True if $1 is a strictly newer x.y.z than $2.
newer_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

if [ "$IF_NEWER" = 1 ] && [ -d "$PREFIX" ] && [ -z "$BUNDLE" ]; then
  HAVE="$(installed_version)"
  LATEST="$(curl -fsSL -H 'Accept: application/vnd.github+json' "${PEAR_RELEASES_API:-https://api.github.com/repos/$REPO/releases/latest}" \
    | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -1)" || LATEST=""
  [ -n "$LATEST" ] || { warn "Could not find out the latest release; leaving $HAVE in place."; exit 0; }
  if ! newer_than "$LATEST" "$HAVE"; then say "Pear server $HAVE is up to date."; exit 0; fi
  say "Pear server $LATEST is available (installed: $HAVE)"
  VERSION="v$LATEST"
fi

if [ "$WHEN_IDLE" = 1 ] && [ -d "$PREFIX" ]; then
  STATUS="$(getent passwd "$RUN_USER" | cut -d: -f6)/.local/share/pear-server/status.json"
  if [ -f "$STATUS" ] && [ -d /run/systemd/system ] && systemctl is-active --quiet pear-server 2>/dev/null; then
    TERMS="$(sed -n 's/.*"terminals": *\([0-9]*\).*/\1/p' "$STATUS")"
    BUSY="$(sed -n 's/.*"claudeBusy": *\(true\|false\).*/\1/p' "$STATUS")"
    if [ "${TERMS:-0}" != 0 ] || [ "$BUSY" = true ]; then
      say "Not updating now: ${TERMS:-0} terminal(s) open$([ "$BUSY" = true ] && echo ', Claude is working'). A restart would end them."
      exit 0
    fi
  fi
fi

command -v apt-get >/dev/null || die "This installer supports Debian and Ubuntu. Elsewhere: docs/SERVER.md (Docker, or from source)."
export DEBIAN_FRONTEND=noninteractive

# ---- prerequisites -------------------------------------------------------------
say "Installing prerequisites"
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar >/dev/null

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; }
if ! node_ok; then
  say "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Node.js 20 or newer is required (found: $(node -v 2>/dev/null || echo none))"

# ---- user ------------------------------------------------------------------------
if ! id "$RUN_USER" >/dev/null 2>&1; then
  say "Creating user '$RUN_USER'"
  useradd --create-home --shell /bin/bash "$RUN_USER"
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
as_user() { runuser -u "$RUN_USER" -- env HOME="$RUN_HOME" "$@"; }

# ---- program -----------------------------------------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
if [ -z "$BUNDLE" ]; then
  if [ "$VERSION" = latest ]; then
    BUNDLE="$DOWNLOAD_BASE/latest/download/pear-server.tar.gz"
  else
    BUNDLE="$DOWNLOAD_BASE/download/$VERSION/pear-server.tar.gz"
  fi
fi
say "Fetching $BUNDLE"
case "$BUNDLE" in
  http://*|https://*) curl -fL --progress-bar -o "$TMP/bundle.tgz" "$BUNDLE" \
    || die "Download failed. No release with a server bundle yet? Build one: 'npm run pack:server', then --bundle <file>." ;;
  *) [ -f "$BUNDLE" ] || die "No such file: $BUNDLE"; cp "$BUNDLE" "$TMP/bundle.tgz" ;;
esac
tar -xzf "$TMP/bundle.tgz" -C "$TMP"
[ -f "$TMP/pear-server/server/dist/cli.js" ] || die "That archive is not a pear-server bundle"

FIRST_INSTALL=1; [ -d "$PREFIX" ] && FIRST_INSTALL=0
WAS_RUNNING=0
if have_systemd && systemctl is-active --quiet pear-server 2>/dev/null; then
  WAS_RUNNING=1
  warn "Updating restarts the server: terminals it is holding will end."
  systemctl stop pear-server
fi

say "Installing into $PREFIX"
rm -rf "$PREFIX.new"; mv "$TMP/pear-server" "$PREFIX.new"
( cd "$PREFIX.new" && npm install --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error >/dev/null )
rm -rf "$PREFIX.old"; [ -d "$PREFIX" ] && mv "$PREFIX" "$PREFIX.old"
mv "$PREFIX.new" "$PREFIX"; rm -rf "$PREFIX.old"
chown -R root:root "$PREFIX"
ln -sf "$PREFIX/server/dist/cli.js" /usr/local/bin/pear-server
chmod +x "$PREFIX/server/dist/cli.js"

# Re-runs keep the port that was configured before unless --port says otherwise.
if [ -z "$PORT" ] && [ -f "$ENV_FILE" ]; then
  PORT="$(sed -n 's/^PEAR_PORT=//p' "$ENV_FILE" | tr -d '"')"
fi
: "${PORT:=7327}"

# ---- configuration -------------------------------------------------------------------
# Re-runs keep what was configured before unless a flag says otherwise.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  : "${PUBLIC_URL:=${PEAR_PUBLIC_URL:-}}"
  : "${AUTH:=${PEAR_AUTH:-}}"
  : "${HOST:=${PEAR_HOST:-}}"
fi
: "${AUTH:=password}"
: "${HOST:=127.0.0.1}"
EXTRA="${PEAR_EXTRA_ARGS:-}"
for proxy in "${TRUSTED_PROXIES[@]}"; do
  [[ " $EXTRA " == *" --trusted-proxy $proxy "* ]] || EXTRA="${EXTRA:+$EXTRA }--trusted-proxy $proxy"
done
is_loopback() { case "$1" in 127.*|localhost|::1) return 0 ;; *) return 1 ;; esac; }
if ! is_loopback "$HOST"; then
  [ "$AUTH" = none ] && [[ " $EXTRA " != *" --allow-unauthenticated-network "* ]] && \
    die "--auth none on $HOST would hand your SSH hosts to the whole network. Use --auth password or proxy (or see --allow-unauthenticated-network in docs/SERVER.md)."
  [ -n "$PUBLIC_URL" ] || warn "Listening on $HOST without --public-url: fine for a first look over plain http, but an iPad needs the https address of your reverse proxy."
fi
if [ "$LOCAL_HOST" = 1 ] && [[ " $EXTRA " != *" --enable-local-host "* ]]; then
  EXTRA="${EXTRA:+$EXTRA }--enable-local-host"
fi
umask 077
cat > "$ENV_FILE" <<EOF
# pear-server settings — edit, then: systemctl restart pear-server
# (restarting ends the terminals the server is holding)
PEAR_HOST=$HOST
PEAR_PORT=$PORT
PEAR_AUTH=$AUTH
PEAR_PUBLIC_URL="$PUBLIC_URL"
# Extra command-line flags, e.g. --enable-local-host --session-grace 24h --trusted-proxy 192.168.1.2
#   identity from your proxy (--auth proxy): --proxy-user-header X-Forwarded-User --allow-user you
PEAR_EXTRA_ARGS="$EXTRA"
EOF
umask 022

PASSWORD_NOTE=""
if [ "$AUTH" = password ] && [ ! -f "$RUN_HOME/.config/pear-server/config.json" ]; then
  PASSWORD_NOTE="$(as_user node "$PREFIX/server/dist/cli.js" --reset-password | sed -n 's/^ *Password: //p')"
fi

# ---- service ---------------------------------------------------------------------------
if [ "$SERVICE" = 1 ] && have_systemd; then
  cat > "$UNIT" <<EOF
[Unit]
Description=Pear server
Documentation=https://github.com/$REPO/blob/main/docs/SERVER.md
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_USER
WorkingDirectory=$RUN_HOME
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/env node $PREFIX/server/dist/cli.js \$PEAR_EXTRA_ARGS
Restart=on-failure
RestartSec=2
# The program is root-owned and read-only to the service; only its own home
# (data, config, the Claude CLI's login) is writable.
NoNewPrivileges=true
ProtectSystem=full
PrivateTmp=false

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable pear-server >/dev/null 2>&1
  systemctl restart pear-server
  sleep 1
  PROBE="$HOST"; { [ "$HOST" = 0.0.0.0 ] || [ "$HOST" = "::" ]; } && PROBE=127.0.0.1
  HEALTH="http://$PROBE:$PORT/healthz"
  # The Host allowlist may not include a bare LAN address; "localhost" always is.
  for _ in $(seq 1 20); do curl -fs -H 'Host: localhost' "$HEALTH" >/dev/null 2>&1 && break; sleep 0.5; done
  curl -fs -H 'Host: localhost' "$HEALTH" >/dev/null 2>&1 \
    || die "The service did not come up. Look at: journalctl -u pear-server -n 50"
  STARTED="running as a service (systemctl status pear-server)"
elif [ "$SERVICE" = 1 ]; then
  warn "No systemd here — not creating a service."
  STARTED="installed. Start it with:  runuser -u $RUN_USER -- env \$(grep -v '^#' $ENV_FILE | xargs) pear-server"
else
  STARTED="installed (no service requested)"
fi

# ---- self-update plumbing ------------------------------------------------------------
# Keep the installer that shipped with this release; the timer runs this copy.
if [ -f "$PREFIX/server/install.sh" ]; then
  install -D -m 0755 "$PREFIX/server/install.sh" "$SELF"
fi
AUTO_NOTE="off  (turn on: re-run with --auto-update)"
if have_systemd && [ "$SERVICE" = 1 ]; then
  if [ "$AUTO_UPDATE" = on ]; then
    [ -f "$SELF" ] || die "--auto-update needs a bundle that ships its installer (any release does)."
    cat > "$UPDATE_UNIT.service" <<UNITEOF
[Unit]
Description=Update Pear server, if a newer release exists and nothing is running
After=network-online.target

[Service]
Type=oneshot
ExecStart=$SELF --if-newer --when-idle --user $RUN_USER
UNITEOF
    cat > "$UPDATE_UNIT.timer" <<UNITEOF
[Unit]
Description=Daily check for a Pear server update

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNITEOF
    systemctl daemon-reload
    systemctl enable --now pear-server-update.timer >/dev/null 2>&1
  elif [ "$AUTO_UPDATE" = off ]; then
    systemctl disable --now pear-server-update.timer >/dev/null 2>&1 || true
    rm -f "$UPDATE_UNIT.service" "$UPDATE_UNIT.timer"; systemctl daemon-reload
  fi
  systemctl is-enabled --quiet pear-server-update.timer 2>/dev/null \
    && AUTO_NOTE="on — daily, only while no terminals or Claude turns are running  (log: journalctl -u pear-server-update)"
fi

# ---- report -------------------------------------------------------------------------------
echo
say "Pear server $(node -p "require('$PREFIX/package.json').version") is $STARTED"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
if [ -n "$PUBLIC_URL" ]; then
  echo "    Open:      $PUBLIC_URL"
fi
if is_loopback "$HOST"; then
  echo "    Listening: http://127.0.0.1:$PORT  (this machine only — for a reverse proxy running here)"
  [ -n "$PUBLIC_URL" ] || echo "    Next:      put HTTPS in front and re-run with --public-url https://…   (docs/SERVER.md)"
else
  echo "    Listening: http://${LAN_IP:-$HOST}:$PORT  ← point your reverse proxy here"
  [[ " $EXTRA " == *" --trusted-proxy "* ]] || echo "    Tip:       re-run with --trusted-proxy <proxy ip> so login throttling sees real client addresses"
fi
case "$AUTH" in
  password)
    if [ -n "$PASSWORD_NOTE" ]; then
      echo "    Password:  $PASSWORD_NOTE"
      echo "               (shown once — only its hash is stored. New one: runuser -u $RUN_USER -- pear-server --reset-password)"
    fi ;;
  none)  echo "    Auth:      none — whoever can reach the address above is in." ;;
  proxy) echo "    Auth:      proxy — set the header flags in $ENV_FILE (see the comment there)." ;;
esac
echo "    Settings:  $ENV_FILE        Data: $RUN_HOME/.local/share/pear-server"
echo "    Updates:   $AUTO_NOTE"
echo "    Claude:    optional — as '$RUN_USER', install the claude CLI and run it once to log in."
[ "$FIRST_INSTALL" = 1 ] && [ -n "$PUBLIC_URL" ] && echo "    iPad:      open the address in Safari → Share → Add to Home Screen → sign in again inside the app."
exit 0
