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
# Offline, or installing a build of your own (`npm run pack:server`): hand it the
# files instead of letting it download them —
#
#   ./proxmox-lxc.sh --bundle pear-server.tar.gz --installer install.sh -- --public-url …
#
# It never touches existing containers, and stops before creating anything if a
# step cannot be satisfied.
set -euo pipefail
# An SSH session forwards the caller's locale; a fresh container has none
# generated, and every perl-based tool inside would complain about it.
export LC_ALL=C LANG=C

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
BUNDLE=""
INSTALLER=""

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
    --bundle) BUNDLE="$2"; shift ;;
    --installer) INSTALLER="$2"; shift ;;
    --) shift; INSTALL_ARGS=("$@"); break ;;
    -h|--help) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done

command -v pct >/dev/null && command -v pveam >/dev/null || die "Run this on a Proxmox VE host (pct/pveam not found)."
[ "$(id -u)" = 0 ] || die "Run as root."
pvesm status --storage "$STORAGE" >/dev/null 2>&1 || die "No storage '$STORAGE' — pick one with --storage (see: pvesm status)."
[ -z "$BUNDLE" ] || [ -f "$BUNDLE" ] || die "No such bundle: $BUNDLE"
[ -z "$INSTALLER" ] || [ -f "$INSTALLER" ] || die "No such installer: $INSTALLER"
[ -z "$BUNDLE" ] || [ -n "$INSTALLER" ] || die "--bundle needs --installer too (the one that came with that build)."
[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."

say "Finding a Debian template"
# pveam lists every architecture (arm64 images sit beside amd64 ones, and sort
# after them): a container built from the wrong one is created fine and then
# simply fails to start.
ARCH="$(dpkg --print-architecture)"
PATTERN="^debian-1[23]-standard_.*_${ARCH}\\.tar\\."
# One that is already here saves a 120 MB download; else the newest on offer.
TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '{print $1}' | sed 's|.*/||' | grep -E "$PATTERN" | sort -V | tail -1)"
if [ -z "$TEMPLATE" ]; then
  pveam update >/dev/null
  TEMPLATE="$(pveam available --section system | awk '{print $2}' | grep -E "$PATTERN" | sort -V | tail -1)"
  [ -n "$TEMPLATE" ] || die "No Debian 12/13 template for $ARCH offered by pveam."
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi
say "Using $TEMPLATE"

say "Creating container $CTID ($NAME): $CORES cores, ${MEMORY} MB, ${DISK} GB on $STORAGE"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$NAME" --unprivileged 1 --features nesting=1,keyctl=1 \
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
if [ -n "$INSTALLER" ]; then
  pct push "$CTID" "$INSTALLER" /root/pear-install.sh --perms 0755
  if [ -n "$BUNDLE" ]; then
    pct push "$CTID" "$BUNDLE" /root/pear-server.tar.gz
    INSTALL_ARGS=(--bundle /root/pear-server.tar.gz "${INSTALL_ARGS[@]}")
  fi
  pct exec "$CTID" -- bash /root/pear-install.sh "${INSTALL_ARGS[@]}"
  pct exec "$CTID" -- rm -f /root/pear-server.tar.gz
else
  pct exec "$CTID" -- bash -c "curl -fsSL '$RAW' | bash -s -- ${INSTALL_ARGS[*]}"
fi

CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
say "Reverse-proxy target: http://${CT_IP:-<container ip>}:7327   (give the container a DHCP reservation or a static IP)"
say "Done. Container $CTID starts with the host. The app tells you when an update exists; to update:"
echo "    pct exec $CTID -- bash -c \"curl -fsSL $RAW | bash\"          # add: -s -- --auto-update  to make it automatic"
