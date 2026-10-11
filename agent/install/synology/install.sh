#!/bin/bash
# Installs (or upgrades) the backup agent on a Synology NAS (DSM 7 or newer).
#
# Usually you don't run this by hand: "Add device" in the web UI gives a one-line command for the
# NAS's SSH terminal that downloads the agent from the gateway and runs this with everything
# filled in.
#
# By hand, first install (over SSH, as an administrator):
#   sudo ./install.sh --gateway http://192.168.1.10:8080 --code ABCD-EFGH-JKLM --allowed "/volume1/Clients"
# Upgrade or repair (e.g. after a big DSM update; keeps the settings and the device's identity):
#   sudo /volume1/@backup-agent/app/install/synology/install.sh
#
# Everything lives on the data volume, in a hidden system folder that isn't a shared folder and
# survives DSM updates (the system partition is small and can be reset by an update):
#   /volumeN/@backup-agent/app        the agent's code
#   /volumeN/@backup-agent/node       Node.js, if Package Center's Node.js v22 isn't installed
#   /volumeN/@backup-agent/agent.env  settings (root only)
#   /volumeN/@backup-agent/data       the agent's database and private keys (root only)
#   /volumeN/@backup-agent/agent.log  the agent's log
# and a "backup-agent" system service that starts with the NAS.

set -euo pipefail

main() {
  SERVICE=backup-agent
  UNIT=/etc/systemd/system/$SERVICE.service
  NODE_DIST=${NODE_DIST:-https://nodejs.org/dist/latest-v22.x}
  PKG_NODE=/var/packages/Node.js_v22/target/usr/local/bin/node
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
                    e.g. "/volume1/Clients;/volume1/homes"
  --watch DIR       Optional first folder to back up (must be inside an allowed folder)
  --name NAME       Device name shown in the web UI (default: the NAS's name)
  -h, --help        Show this help

The first install needs --gateway, --code and --allowed. To upgrade or repair, run it again
with no options.
EOF
  }

  local GATEWAY="" CODE="" ALLOWED="" WATCH="" NAME=""
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
  [ -f /etc.defaults/VERSION ] || die "this doesn't look like a Synology NAS. On other Linux computers, use the Linux installer."
  local DSM_MAJOR
  DSM_MAJOR=$(sed -n 's/^majorversion="\{0,1\}\([0-9]*\)"\{0,1\}$/\1/p' /etc.defaults/VERSION | head -n1)
  [ "${DSM_MAJOR:-0}" -ge 7 ] || die "DSM 7 or newer is needed (this NAS has DSM ${DSM_MAJOR:-unknown}). Update DSM first."
  command -v systemctl >/dev/null || die "systemd was not found on this NAS."
  [ -f "$SRC/package.json" ] && [ -f "$SRC/src/index.js" ] || die "run this from inside the agent folder (agent/install/synology/install.sh)."

  local AGENT_VERSION
  AGENT_VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$SRC/package.json" | head -n1)
  bold "Backup agent $AGENT_VERSION installer for Synology"

  realdir() { realpath -e "$1" 2>/dev/null || readlink -f "$1"; }

  # ---- Where it's installed: an existing install, or the volume of the first allowed folder -----

  local PREFIX=""
  if [ -L "$UNIT" ] || [ -f "$UNIT" ]; then
    PREFIX=$(sed -n 's/^WorkingDirectory=\(.*\)\/app$/\1/p' "$UNIT" | head -n1)
  fi
  if [ -z "$PREFIX" ]; then
    # Running from an installed copy (repair after a DSM update removed the service)
    case "$SRC" in /volume[0-9]*/@backup-agent/app) PREFIX=${SRC%/app} ;; esac
  fi
  local CONF="" UPGRADE=no
  if [ -n "$PREFIX" ] && [ -f "$PREFIX/agent.env" ]; then
    CONF=$PREFIX/agent.env
    UPGRADE=yes
  fi

  current() { [ -n "$CONF" ] && sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" "$CONF" | tail -n1 || true; }

  GATEWAY=${GATEWAY:-$(current AGENT_GATEWAY_URL)}
  ALLOWED=${ALLOWED:-$(current AGENT_ALLOWED_PATHS)}
  WATCH=${WATCH:-$(current AGENT_WATCH_DIR)}
  NAME=${NAME:-$(current AGENT_DEVICE_NAME)}
  NAME=${NAME:-$(hostname)}
  local LOG_LEVEL
  LOG_LEVEL=$(current AGENT_LOG_LEVEL)
  LOG_LEVEL=${LOG_LEVEL:-info}

  [ -n "$GATEWAY" ] || { usage; die "--gateway is needed for the first install."; }
  [ -n "$ALLOWED" ] || { usage; die "--allowed is needed for the first install."; }

  [[ "$GATEWAY" =~ ^https?://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || die "--gateway must look like http://192.168.1.10:8080"
  GATEWAY=${GATEWAY%/}
  [[ -z "$CODE" || "$CODE" =~ ^[A-Za-z0-9-]+$ ]] || die "the enrollment code should only contain letters, numbers and dashes."

  safe_text() { [[ "$2" != *[\"\\\$\`]* && "$2" != *$'\n'* ]] || die "$1 can't contain \" \\ \$ \` or line breaks: $2"; }
  safe_text "--name" "$NAME"

  # Allowed areas: shared folders (or folders inside them) on a data volume
  local ALLOWED_LIST=() p real parts=()
  IFS=';' read -r -a parts <<<"$ALLOWED"
  for p in "${parts[@]}"; do
    p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
    [ -n "$p" ] || continue
    safe_text "allowed folder" "$p"
    [ -d "$p" ] || die "allowed folder doesn't exist: $p"
    real=$(realdir "$p")
    [[ "$real" =~ ^/volume[0-9]+/[^/]+ ]] ||
      die "allowed folders must be shared folders (or folders inside them) on a volume, like /volume1/Clients: $real"
    [[ "$real" != /volume*/@* && "$real" != /volume*/\#* ]] || die "this is a DSM system folder, not a shared folder: $real"
    ALLOWED_LIST+=("$real")
  done
  [ ${#ALLOWED_LIST[@]} -gt 0 ] || die "--allowed has no folders in it."
  ALLOWED=$(IFS=';'; printf '%s' "${ALLOWED_LIST[*]}")

  inside_allowed() {
    local a
    for a in "${ALLOWED_LIST[@]}"; do [[ "$1" = "$a" || "$1" = "$a"/* ]] && return 0; done
    return 1
  }
  if [ -n "$WATCH" ]; then
    safe_text "--watch" "$WATCH"
    [ -d "$WATCH" ] || die "--watch folder doesn't exist: $WATCH"
    WATCH=$(realdir "$WATCH")
    inside_allowed "$WATCH" || die "--watch folder must be inside one of the allowed folders: $WATCH"
  fi

  if [ -z "$PREFIX" ]; then
    PREFIX=/$(printf '%s' "${ALLOWED_LIST[0]}" | cut -d/ -f2)/@backup-agent
  fi
  CONF=$PREFIX/agent.env
  local DATA_DIR=$PREFIX/data
  local LOG_FILE=$PREFIX/agent.log

  # Already enrolled: a code is never needed again
  local ENROLLED=no
  [ -f "$DATA_DIR/identity.json" ] && ENROLLED=yes
  if [ "$ENROLLED" = no ] && [ -z "$CODE" ]; then
    usage
    die "--code is needed: this NAS isn't enrolled yet. Create a code in the web UI (Devices → Add device)."
  fi
  [ "$ENROLLED" = yes ] && CODE=""

  echo "  Gateway:         $GATEWAY"
  echo "  Allowed folders: ${ALLOWED//;/, }"
  [ -n "$WATCH" ] && echo "  First folder:    $WATCH"
  echo "  Device name:     $NAME"
  echo "  Installed in:    $PREFIX"
  [ "$UPGRADE" = yes ] && echo "  (upgrading the existing install, the NAS keeps its identity)"
  echo

  # ---- Node.js: Package Center's Node.js v22, or the official build -----------------------------

  version_ok() { "$1" -e "const [a,b]=process.versions.node.split('.').map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)" 2>/dev/null; }
  download() {
    if command -v curl >/dev/null; then curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"
    elif command -v wget >/dev/null; then wget -q --https-only "$1" -O "$2"
    else die "neither curl nor wget is installed, so Node.js can't be downloaded."
    fi
  }
  sha256_ok() { # file expected-hash
    local got
    if command -v sha256sum >/dev/null; then got=$(sha256sum "$1" | cut -d' ' -f1)
    else got=$(openssl dgst -sha256 -r "$1" | cut -d' ' -f1)
    fi
    [ "$got" = "$2" ]
  }

  local NODE="" candidate
  for candidate in "$PREFIX/node/bin/node" "$PKG_NODE" "$(command -v node || true)"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    [ "$(stat -c '%u' "$(realdir "$candidate")")" = 0 ] || continue # only a copy root owns
    if version_ok "$candidate"; then NODE=$(realdir "$candidate"); break; fi
  done

  if [ -z "$NODE" ]; then
    local ARCH
    case "$(uname -m)" in
      x86_64) ARCH=x64 ;;
      aarch64 | arm64) ARCH=arm64 ;;
      *) die "no ready-made Node.js for this NAS's processor ($(uname -m)). Install Node.js v22 from Package Center, then run this again." ;;
    esac
    bold "Downloading Node.js 22 ($ARCH)..."
    local TARBALL SUM
    TMP=$(mktemp -d) # not local: the clean-up below runs after main() returns
    trap 'rm -rf "${TMP:-}"' EXIT
    download "$NODE_DIST/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
    TARBALL=$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -n1)
    [ -n "$TARBALL" ] || die "couldn't find the Node.js download in the official list."
    SUM=$(grep " $TARBALL\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)
    download "$NODE_DIST/$TARBALL" "$TMP/$TARBALL"
    sha256_ok "$TMP/$TARBALL" "$SUM" || die "the Node.js download failed its SHA-256 check. Nothing was installed."
    ok "Node.js download verified (SHA-256)"
    mkdir -p "$TMP/node"
    tar -xzf "$TMP/$TARBALL" -C "$TMP/node" --strip-components=1 --no-same-owner
    "$TMP/node/bin/node" -e 0 2>/dev/null ||
      die "the official Node.js doesn't run on this DSM version. Install Node.js v22 from Package Center
       (Package Center → search \"Node.js\" → Node.js v22), then run this again."
    mkdir -p "$PREFIX"
    rm -rf "$PREFIX/node.new"
    mv "$TMP/node" "$PREFIX/node.new"
    rm -rf "$PREFIX/node"
    mv "$PREFIX/node.new" "$PREFIX/node"
    NODE=$PREFIX/node/bin/node
  fi
  local NODE_DIR NPM
  NODE_DIR=$(dirname "$NODE")
  NPM=$NODE_DIR/npm
  [ -x "$NPM" ] || NPM=$(command -v npm || true)
  [ -n "$NPM" ] || die "npm was not found next to $NODE."
  ok "Node.js $("$NODE" -p 'process.versions.node') at $NODE"

  # ---- The agent's code -------------------------------------------------------------------------

  bold "Installing the agent..."
  mkdir -p "$PREFIX"
  chmod 0711 "$PREFIX"
  local STAGE=$PREFIX/app.new
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  cp -r "$SRC/src" "$SRC/install" "$SRC/package.json" "$SRC/package-lock.json" "$STAGE/"
  (cd "$STAGE" && PATH="$NODE_DIR:$PATH" HOME="$PREFIX" "$NPM" ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error --cache "$PREFIX/.npm") ||
    die "installing the agent's packages failed (see above)."
  rm -rf "$PREFIX/.npm"
  chown -R root:root "$STAGE"
  chmod -R u=rwX,go=rX "$STAGE"
  ok "agent $AGENT_VERSION ready"

  # ---- Settings and data folder -----------------------------------------------------------------

  umask 077
  cat >"$CONF.new" <<EOF
# Backup agent settings. Written by install.sh; run it again to change them, e.g.
#   sudo $PREFIX/app/install/synology/install.sh --allowed "/volume1/Clients;/volume1/homes"
# then the agent restarts by itself.

AGENT_GATEWAY_URL="$GATEWAY"
AGENT_ALLOWED_PATHS="$ALLOWED"
AGENT_WATCH_DIR="$WATCH"
AGENT_DEVICE_NAME="$NAME"
AGENT_DATA_DIR="$DATA_DIR"
AGENT_LOG_LEVEL="$LOG_LEVEL"
AGENT_LOG_FILE="$LOG_FILE"
AGENT_ENROLL_CODE="$CODE"
EOF
  chmod 0600 "$CONF.new"
  mv "$CONF.new" "$CONF"
  mkdir -p "$DATA_DIR"
  chmod 0700 "$DATA_DIR"
  touch "$LOG_FILE" # the log names files and folders: root only
  chmod 0600 "$LOG_FILE"
  umask 022
  ok "settings saved to $CONF"

  # ---- The service ------------------------------------------------------------------------------

  cat >"$UNIT.new" <<EOF
# Backup agent: watches the backup folders and sends changes to the backup gateway.
# Written by install.sh — run it again to change the settings instead of editing this file:
#   sudo $PREFIX/app/install/synology/install.sh

[Unit]
Description=Backup agent (sends changes to the backup gateway)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$PREFIX/app
EnvironmentFile=$CONF
# Lets the agent watch large folders for changes live
ExecStartPre=-/bin/sh -c 'sysctl -q -w fs.inotify.max_user_watches=1048576 || true'
ExecStart=$NODE --disable-warning=ExperimentalWarning $PREFIX/app/src/index.js
Restart=always
RestartSec=10
TimeoutStopSec=60
# Stay in the background: lower CPU and disk priority than file sharing and DSM
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
NoNewPrivileges=yes
UMask=0022

[Install]
WantedBy=multi-user.target
EOF
  chmod 0644 "$UNIT.new"
  mv "$UNIT.new" "$UNIT"

  # Swap in the new code only now, with the service stopped
  systemctl stop "$SERVICE" 2>/dev/null || true
  rm -rf "$PREFIX/app.old"
  [ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
  mv "$STAGE" "$PREFIX/app"
  rm -rf "$PREFIX/app.old"

  systemctl daemon-reload
  local LOG_START=0
  [ -f "$LOG_FILE" ] && LOG_START=$(wc -c <"$LOG_FILE")
  systemctl enable --quiet "$SERVICE"
  systemctl restart "$SERVICE"
  ok "service $SERVICE installed and started"

  # ---- Check that it enrolled -------------------------------------------------------------------

  new_log() { [ -f "$LOG_FILE" ] && tail -c +$((LOG_START + 1)) "$LOG_FILE" 2>/dev/null || true; }
  show_log() { echo; echo "Last lines of the agent's log:"; new_log | tail -n 25; }

  if [ "$ENROLLED" = no ]; then
    printf '  waiting for the agent to enroll with the gateway'
    for _ in $(seq 1 45); do
      [ -f "$DATA_DIR/identity.json" ] && break
      systemctl is-active --quiet "$SERVICE" || break
      new_log | grep -q "Enrollment failed" && break
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
    sed -i 's/^AGENT_ENROLL_CODE=.*/AGENT_ENROLL_CODE=""/' "$CONF"
    ok "enrolled: $(sed -n 's/.*"clientName": *"\([^"]*\)".*/client "\1"/p' "$DATA_DIR/identity.json")"
  else
    sleep 2
    systemctl is-active --quiet "$SERVICE" || { show_log; die "the agent stopped right after starting (see the log above)."; }
  fi

  echo
  bold "Done. The agent runs in the background and starts with the NAS."
  echo "  Status:     sudo systemctl status $SERVICE"
  echo "  Live log:   sudo tail -f $LOG_FILE"
  echo "  Folders:    add or remove them from the gateway's web UI (Devices → this NAS)"
  echo "  Repair:     sudo $PREFIX/app/install/synology/install.sh   (if a big DSM update removes the service)"
  echo "  Uninstall:  sudo $PREFIX/app/install/synology/uninstall.sh"
}

# Everything is in main(), so bash has read the whole script before it starts replacing files
main "$@"
