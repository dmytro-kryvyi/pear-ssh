#!/usr/bin/env bash
# Create a Proxmox LXC container for pear-server and install Pear in it.
# Run on the Proxmox HOST, as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/dmytro-kryvyi/pear-ssh/main/server/proxmox-lxc.sh)"
#
# It creates a small unprivileged Debian container and runs server/install.sh
# inside, listening on the container's LAN address so a reverse proxy elsewhere
# on your network can reach it. Anything after `--` goes to the installer:
#
#   … proxmox-lxc.sh --storage local-zfs -- --public-url https://pear.example.com --trusted-proxy 192.168.1.2
#
# --tun additionally passes /dev/net/tun into the container, for running a VPN
# client (Tailscale, WireGuard) inside it.
#
# It never touches existing containers, and stops before creating anything if a
# step cannot be satisfied.
set -euo pipefail

RAW="https://raw.githubusercontent.com/dmytro-kryvyi/pear-ssh/main/server/install.sh"
CTID=""
NAME="pear"
STORAGE="local-lvm"
TEMPLATE_STORAGE="local"
BRIDGE="vmbr0"
CORES=2
MEMORY=1024
DISK=4
INSTALL_ARGS=()
TUN=0

say() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --id) CTID="$2"; shift ;;
    --name) NAME="$2"; shift ;;
    --storage) STORAGE="$2"; shift ;;
    --template-storage) TEMPLATE_STORAGE="$2"; shift ;;
    --bridge) BRIDGE="$2"; shift ;;
    --cores) CORES="$2"; shift ;;
    --memory) MEMORY="$2"; shift ;;
    --disk) DISK="$2"; shift ;;
    --tun) TUN=1 ;;
    --) shift; INSTALL_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

command -v pct >/dev/null && command -v pveam >/dev/null || die "Run this on a Proxmox VE host (pct/pveam not found)."
[ "$(id -u)" = 0 ] || die "Run as root."
pvesm status --storage "$STORAGE" >/dev/null 2>&1 || die "No storage '$STORAGE' — pick one with --storage (see: pvesm status)."
[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."

say "Finding a Debian template"
pveam update >/dev/null
TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-1[23]-standard' | sort -V | tail -1)"
[ -n "$TEMPLATE" ] || die "No Debian 12/13 template offered by pveam."
pveam list "$TEMPLATE_STORAGE" | grep -q "$TEMPLATE" || pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"

say "Creating container $CTID ($NAME): $CORES cores, ${MEMORY} MB, ${DISK} GB on $STORAGE"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$NAME" --unprivileged 1 --features nesting=1 \
  --cores "$CORES" --memory "$MEMORY" --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --onboot 1

# A VPN client needs the tun device; an unprivileged container has none by default.
if [ "$TUN" = 1 ]; then
  cat >> "/etc/pve/lxc/$CTID.conf" <<CONF
lxc.cgroup2.devices.allow: c 10:200 rwm
lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file
CONF
fi

pct start "$CTID"
say "Waiting for the network inside the container"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1' && break
  sleep 2
done
pct exec "$CTID" -- sh -c 'getent hosts deb.debian.org >/dev/null 2>&1' \
  || die "Container $CTID has no network (DHCP on $BRIDGE?). Fix that, then inside it run: curl -fsSL $RAW | bash -s -- ${INSTALL_ARGS[*]}"

say "Installing Pear inside container $CTID"
pct exec "$CTID" -- sh -c 'apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null'
# Listen on the LAN unless told otherwise: the proxy is somewhere else on it.
[[ " ${INSTALL_ARGS[*]} " == *" --host "* ]] || INSTALL_ARGS=(--host 0.0.0.0 "${INSTALL_ARGS[@]}")
pct exec "$CTID" -- bash -c "curl -fsSL '$RAW' | bash -s -- ${INSTALL_ARGS[*]}"

CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
say "Reverse-proxy target: http://${CT_IP:-<container ip>}:7327   (give the container a DHCP reservation or a static IP)"
say "Done. Container $CTID starts with the host. The app tells you when an update exists; to update:"
echo "    pct exec $CTID -- bash -c \"curl -fsSL $RAW | bash\"          # add: -s -- --auto-update  to make it automatic"
