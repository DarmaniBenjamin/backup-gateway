#!/usr/bin/env bash
# Installs (or upgrades) the backup agent on a Linux PC or server as a systemd service.
#
# Usually you don't run this by hand: "Add device" in the web UI gives a one-line command that
# downloads the agent from the gateway and runs this with everything filled in.
#
# By hand, first install:
#   sudo ./install.sh --gateway http://192.168.1.10:8080 --code ABCD-EFGH-JKLM --allowed "/home;/srv/shared"
# Upgrade (keeps the settings and the device's identity): run it again from a newer copy:
#   sudo ./install.sh
#
# What it sets up:
#   /opt/backup-agent/app        the agent's code (and /opt/backup-agent/node if Node.js had to be downloaded)
#   /etc/backup-agent/agent.env  settings, readable by root and the agent only
#   /var/lib/backup-agent        the agent's database and private keys (owner-only)
#   backup-agent.service         runs as its own "backup-agent" user, not root, with only the rights it
#                                needs: read any file, and write only inside the allowed areas (restores)

set -euo pipefail

SERVICE=backup-agent
APP_USER=backup-agent
PREFIX=/opt/backup-agent
CONF_DIR=/etc/backup-agent
CONF=$CONF_DIR/agent.env
DATA_DIR=/var/lib/backup-agent
UNIT=/etc/systemd/system/$SERVICE.service
NODE_MIN=22.13.0
NODE_DIST=${NODE_DIST:-https://nodejs.org/dist/latest-v22.x}
SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<EOF
Usage: sudo $0 [options]

  --gateway URL     Address of the backup gateway, e.g. http://192.168.1.10:8080
  --code CODE       One-time enrollment code from the gateway's web UI (Devices → Add device)
  --allowed PATHS   The ONLY folders the gateway may back up or browse, separated by ;
                    e.g. "/home;/srv/shared"
  --watch DIR       Optional first folder to back up (must be inside an allowed folder).
                    More folders can be added from the web UI later.
  --name NAME       Device name shown in the web UI (default: this computer's hostname)
  -h, --help        Show this help

The first install needs --gateway, --code and --allowed. To upgrade, run it again with no options.
EOF
}

GATEWAY="" CODE="" ALLOWED="" WATCH="" NAME=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gateway) GATEWAY=${2-}; shift 2 ;;
    --code) CODE=${2-}; shift 2 ;;
    --allowed) ALLOWED=${2-}; shift 2 ;;
    --watch) WATCH=${2-}; shift 2 ;;
    --name) NAME=${2-}; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *) usage; die "unknown option: $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "run this with sudo (it installs a system service)."
command -v systemctl >/dev/null || die "systemd was not found. This installer needs a systemd-based Linux."
[ -f "$SRC/package.json" ] && [ -f "$SRC/src/index.js" ] || die "run this from inside the agent folder (agent/install/linux/install.sh)."

AGENT_VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -n1)
bold "Backup agent $AGENT_VERSION installer"

# ---- Settings: new values from the options, otherwise what's already installed ----------------

current() { [ -f "$CONF" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$CONF" | tail -n1 || true; }

UPGRADE=no
[ -f "$CONF" ] && UPGRADE=yes
ENROLLED=no
[ -f "$DATA_DIR/identity.json" ] && ENROLLED=yes

GATEWAY=${GATEWAY:-$(current AGENT_GATEWAY_URL)}
ALLOWED=${ALLOWED:-$(current AGENT_ALLOWED_PATHS)}
WATCH=${WATCH:-$(current AGENT_WATCH_DIR)}
NAME=${NAME:-$(current AGENT_DEVICE_NAME)}
NAME=${NAME:-$(hostname)}
LOG_LEVEL=$(current AGENT_LOG_LEVEL)
LOG_LEVEL=${LOG_LEVEL:-info}

[ -n "$GATEWAY" ] || { usage; die "--gateway is needed for the first install."; }
[ -n "$ALLOWED" ] || { usage; die "--allowed is needed for the first install."; }
if [ "$ENROLLED" = no ] && [ -z "$CODE" ]; then
  usage
  die "--code is needed: this device isn't enrolled yet. Create a code in the web UI (Devices → Add device)."
fi
[ "$ENROLLED" = yes ] && CODE="" # already enrolled: a code is never needed again

[[ "$GATEWAY" =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || die "--gateway must look like http://192.168.1.10:8080"
GATEWAY=${GATEWAY%/}
[[ -z "$CODE" || "$CODE" =~ ^[A-Za-z0-9-]+$ ]] || die "the enrollment code should only contain letters, numbers and dashes."

# Text that goes into the settings file and the service file can't contain quotes, backslashes,
# $ signs or line breaks (they would change its meaning there)
safe_text() { [[ "$2" != *[\"\\\$\`]* && "$2" != *$'\n'* ]] || die "$1 can't contain \" \\ \$ \` or line breaks: $2"; }
safe_text "--name" "$NAME"

# Allowed areas: absolute, existing folders; stored as their real paths
ALLOWED_LIST=()
IFS=';' read -r -a parts <<<"$ALLOWED"
for p in "${parts[@]}"; do
  p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  [ -n "$p" ] || continue
  [[ "$p" = /* ]] || die "allowed folder must be a full path starting with /: $p"
  safe_text "allowed folder" "$p"
  [ -d "$p" ] || die "allowed folder doesn't exist: $p"
  real=$(realpath -e "$p")
  [ "$real" != / ] || die "allowing the whole disk (/) isn't supported. List the folders with data instead, e.g. \"/home;/srv\"."
  case "$real" in /proc | /proc/* | /sys | /sys/* | /dev | /dev/* | /run | /run/* | "$DATA_DIR" | "$DATA_DIR"/* | "$PREFIX" | "$PREFIX"/* | "$CONF_DIR" | "$CONF_DIR"/*)
    die "this folder can't be an allowed folder: $real" ;;
  esac
  ALLOWED_LIST+=("$real")
done
[ ${#ALLOWED_LIST[@]} -gt 0 ] || die "--allowed has no folders in it."
ALLOWED=$(IFS=';'; printf '%s' "${ALLOWED_LIST[*]}")

inside_allowed() {
  local a
  for a in "${ALLOWED_LIST[@]}"; do
    [[ "$1" = "$a" || "$1" = "$a"/* ]] && return 0
  done
  return 1
}
if [ -n "$WATCH" ]; then
  safe_text "--watch" "$WATCH"
  [ -d "$WATCH" ] || die "--watch folder doesn't exist: $WATCH"
  WATCH=$(realpath -e "$WATCH")
  inside_allowed "$WATCH" || die "--watch folder must be inside one of the allowed folders: $WATCH"
fi

echo "  Gateway:         $GATEWAY"
echo "  Allowed folders: ${ALLOWED//;/, }"
[ -n "$WATCH" ] && echo "  First folder:    $WATCH"
echo "  Device name:     $NAME"
[ "$UPGRADE" = yes ] && echo "  (upgrading the existing install, the device keeps its identity)"
echo

# ---- Node.js: use the system's if it's new enough, otherwise download the official build -------

version_ok() { [ "$(printf '%s\n%s\n' "$NODE_MIN" "$1" | sort -V | head -n1)" = "$NODE_MIN" ]; }

download() {
  if command -v curl >/dev/null; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -q --https-only "$1" -O "$2"
  else die "neither curl nor wget is installed, so Node.js can't be downloaded. Install one of them, or Node.js $NODE_MIN+."
  fi
}

# The service runs Node.js with extra rights, so it must be a copy only root can change
# (not one in someone's home folder, like an nvm install)
root_only() {
  local f=$1
  while [ "$f" != / ]; do
    [ "$(stat -c '%u' "$f")" = 0 ] || return 1
    [ $((0$(stat -c '%a' "$f") & 022)) -eq 0 ] || [ -k "$f" ] || return 1
    f=$(dirname "$f")
  done
}

NODE=""
for candidate in "$PREFIX/node/bin/node" "$(command -v node || true)"; do
  [ -n "$candidate" ] && [ -x "$candidate" ] || continue
  candidate=$(realpath "$candidate")
  root_only "$candidate" || { echo "  (skipping $candidate: it isn't a system-wide install only root can change)"; continue; }
  v=$("$candidate" -p 'process.versions.node' 2>/dev/null || true)
  if [ -n "$v" ] && version_ok "$v"; then NODE=$candidate; break; fi
done

if [ -z "$NODE" ]; then
  case "$(uname -m)" in
    x86_64) ARCH=x64 ;;
    aarch64 | arm64) ARCH=arm64 ;;
    *) die "no ready-made Node.js for $(uname -m). Install Node.js $NODE_MIN or newer, then run this again." ;;
  esac
  bold "Downloading Node.js 22 ($ARCH)..."
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  download "$NODE_DIST/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  TARBALL=$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -n1)
  [ -n "$TARBALL" ] || die "couldn't find the Node.js download in the official list."
  download "$NODE_DIST/$TARBALL" "$TMP/$TARBALL"
  (cd "$TMP" && grep " $TARBALL\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "the Node.js download failed its SHA-256 check. Nothing was installed."
  ok "Node.js download verified (SHA-256)"
  mkdir -p "$TMP/node"
  tar -xJf "$TMP/$TARBALL" -C "$TMP/node" --strip-components=1 --no-same-owner
  rm -rf "$PREFIX/node.new"
  mkdir -p "$PREFIX"
  mv "$TMP/node" "$PREFIX/node.new"
  rm -rf "$PREFIX/node"
  mv "$PREFIX/node.new" "$PREFIX/node"
  NODE=$PREFIX/node/bin/node
fi
NODE_DIR=$(dirname "$NODE")
NPM=$NODE_DIR/npm
[ -x "$NPM" ] || NPM=$(command -v npm || true)
[ -n "$NPM" ] || die "npm was not found next to $NODE. Install npm, then run this again."
ok "Node.js $("$NODE" -p 'process.versions.node') at $NODE"

# ---- The agent's code -------------------------------------------------------------------------

bold "Installing the agent..."
mkdir -p "$PREFIX"
STAGE=$PREFIX/app.new
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r "$SRC/src" "$SRC/package.json" "$SRC/package-lock.json" "$STAGE/"
(cd "$STAGE" && PATH="$NODE_DIR:$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error) || die "installing the agent's packages failed (see above)."
chown -R root:root "$STAGE"
chmod -R u=rwX,go=rX "$STAGE"
ok "agent $AGENT_VERSION ready"

# ---- Service user, settings and data folder ---------------------------------------------------

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin \
    --comment "Backup agent" "$APP_USER"
  ok "created the $APP_USER system user"
fi

mkdir -p "$CONF_DIR"
chmod 0755 "$CONF_DIR"
umask 077
cat >"$CONF.new" <<EOF
# Backup agent settings. Written by install.sh; run it again to change them, e.g.
#   sudo ./install.sh --allowed "/home;/srv/shared"
# then the agent restarts by itself.

AGENT_GATEWAY_URL="$GATEWAY"
AGENT_ALLOWED_PATHS="$ALLOWED"
AGENT_WATCH_DIR="$WATCH"
AGENT_DEVICE_NAME="$NAME"
AGENT_DATA_DIR="$DATA_DIR"
AGENT_LOG_LEVEL="$LOG_LEVEL"
AGENT_ENROLL_CODE="$CODE"
EOF
chown root:"$APP_USER" "$CONF.new"
chmod 0640 "$CONF.new"
mv "$CONF.new" "$CONF"
umask 022
ok "settings saved to $CONF"

# A watch for each folder: raise the Linux limit so big folders can be watched live
SYSCTL=/etc/sysctl.d/90-backup-agent.conf
if [ "$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null || echo 0)" -lt 1048576 ] || [ ! -f "$SYSCTL" ]; then
  printf '# Lets the backup agent watch large folders for changes live\nfs.inotify.max_user_watches = 1048576\n' >"$SYSCTL"
  sysctl -q -p "$SYSCTL" 2>/dev/null || sysctl -q -w fs.inotify.max_user_watches=1048576 2>/dev/null ||
    echo "  (couldn't raise the folder-watch limit now; it applies after a reboot)"
fi

# ---- The service ------------------------------------------------------------------------------

# Paths in the service file are quoted, so folders with spaces work
quoted_paths() { local out="" p; for p in "$@"; do out+=" \"$p\""; done; printf '%s' "${out# }"; }
RW_PATHS=()
for a in "${ALLOWED_LIST[@]}"; do RW_PATHS+=("-$a"); done
# Secrets the agent never needs to read, unless one of them is (inside) an allowed folder
HIDDEN=()
for s in /root /etc/shadow /etc/gshadow /etc/ssh /etc/sudoers /etc/sudoers.d; do
  inside_allowed "$s" && continue
  covered=no
  for a in "${ALLOWED_LIST[@]}"; do [[ "$a" = "$s"/* ]] && covered=yes; done
  [ "$covered" = no ] && HIDDEN+=("-$s")
done

cat >"$UNIT.new" <<EOF
# Backup agent: watches the backup folders and sends changes to the backup gateway.
# Written by install.sh — run it again to change the settings instead of editing this file.

[Unit]
Description=Backup agent (sends changes to the backup gateway)
Documentation=https://github.com/DarmaniBenjamin/backup-gateway
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$PREFIX/app
EnvironmentFile=$CONF
ExecStart=$NODE --disable-warning=ExperimentalWarning $PREFIX/app/src/index.js
Restart=always
RestartSec=10
TimeoutStopSec=60

# Stay in the background: lower CPU and disk priority than the person using the computer.
# (The "low priority" switch in the web UI can lower it further but not raise it.)
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7

# Rights: read any file (to back it up), write files and give them to their owner (restores).
# Nothing else that root can do.
AmbientCapabilities=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER
CapabilityBoundingSet=CAP_DAC_READ_SEARCH CAP_DAC_OVERRIDE CAP_CHOWN CAP_FOWNER
NoNewPrivileges=yes

# The whole system is read-only for the agent, except its own data folder and the allowed
# folders (where restores go). Even a compromised agent can't change anything else.
ProtectSystem=strict
StateDirectory=$SERVICE
StateDirectoryMode=0700
ReadWritePaths=$(quoted_paths "${RW_PATHS[@]}")
InaccessiblePaths=$(quoted_paths "${HIDDEN[@]}")
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
UMask=0022

[Install]
WantedBy=multi-user.target
EOF
mv "$UNIT.new" "$UNIT"
chmod 0644 "$UNIT"

# Swap in the new code only now, with the service stopped
systemctl stop "$SERVICE" 2>/dev/null || true
rm -rf "$PREFIX/app.old"
[ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$STAGE" "$PREFIX/app"
rm -rf "$PREFIX/app.old"
install -m 0755 "$SRC/install/linux/uninstall.sh" "$PREFIX/uninstall.sh"

# The data folder from an earlier install keeps its keys: make sure it belongs to the agent user
if [ -d "$DATA_DIR" ]; then chown -R "$APP_USER:$APP_USER" "$DATA_DIR"; chmod 0700 "$DATA_DIR"; fi

systemctl daemon-reload
STARTED=$(date '+%Y-%m-%d %H:%M:%S')
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"
ok "service $SERVICE installed and started"

# ---- Check that it enrolled -------------------------------------------------------------------

show_log() { echo; echo "Last lines of the agent's log:"; journalctl -u "$SERVICE" -n 25 --no-pager 2>/dev/null || true; }

if [ "$ENROLLED" = no ]; then
  printf '  waiting for the agent to enroll with the gateway'
  for _ in $(seq 1 45); do
    [ -f "$DATA_DIR/identity.json" ] && break
    systemctl is-active --quiet "$SERVICE" || break
    grep -q "Enrollment failed" <<<"$(journalctl -u "$SERVICE" --since "$STARTED" -q --no-pager 2>/dev/null || true)" && break
    sleep 1
    printf '.'
  done
  echo
  if [ ! -f "$DATA_DIR/identity.json" ]; then
    systemctl stop "$SERVICE" || true
    show_log
    echo
    die "the agent didn't enroll (see the log above). Check the gateway address, create a new code
       in the web UI, then run this again with --code NEW-CODE. Everything else is already installed."
  fi
  # The code was single-use and is spent: take it out of the settings file
  sed -i 's/^AGENT_ENROLL_CODE=.*/AGENT_ENROLL_CODE=""/' "$CONF"
  ok "enrolled: $(sed -n 's/.*"clientName": *"\([^"]*\)".*/client "\1"/p' "$DATA_DIR/identity.json")"
else
  sleep 2
  systemctl is-active --quiet "$SERVICE" || { show_log; die "the agent stopped right after starting (see the log above)."; }
fi

echo
bold "Done. The agent runs in the background and starts with the computer."
echo "  Status:     systemctl status $SERVICE"
echo "  Live log:   journalctl -u $SERVICE -f"
echo "  Folders:    add or remove them from the gateway's web UI (Devices → this device)"
echo "  Uninstall:  sudo $PREFIX/uninstall.sh"
