#!/usr/bin/env bash
# =====================================================================
#  Install the backup gateway on its computer, in one go
# =====================================================================
# For the computer that will be the gateway: a cloud VM (Linode...), or a
# machine on site. Ubuntu, Debian or Arch (Omarchy). As your normal user:
#
#   git clone https://github.com/DarmaniBenjamin/backup-gateway.git
#   cd backup-gateway
#   sudo bash deploy/install.sh
#
# It asks a few questions, then by itself:
#   1. installs Node.js 22 and the tools it needs
#   2. installs ClamAV (the antivirus that scans every backup) and its signatures
#   3. sets where the backups are kept
#   4. sets how devices reach the gateway:
#        - online: a cloud VM, or a machine on site. Installs Caddy and
#          cloudflared; you then add your domain on the web UI's Certificate
#          page (your domain + its own certificate, or a Cloudflare Tunnel)
#        - this network only: for testing
#   5. builds the web UI and runs the gateway as a service, started on every
#      boot and restarted if it ever stops
#   6. opens the firewall ports it needs
#   7. makes your web UI admin account, and adds the update-gateway command
#
# The web UI (port 8090) only ever listens on this computer: from your laptop
# you reach it through SSH (the command is printed at the end).
#
# Safe to run again: what's done stays as it is, and the questions show
# the current answers.
# =====================================================================

set -Eeuo pipefail

ok()   { printf '  \e[32m✓\e[0m %s\n' "$1"; }
warn() { printf '  \e[33m!\e[0m %s\n' "$1"; }
die()  { printf '\n\e[31m✗ %s\e[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\e[1m%s\e[0m\n' "$1"; }
trap 'die "Stopped on line $LINENO."' ERR

# Questions are read from the keyboard, even when the script's own input isn't a terminal
# (without a keyboard, e.g. answers piped in, from standard input)
if (exec </dev/tty) 2>/dev/null; then IN=/dev/tty OUT=/dev/tty; else IN=/dev/stdin OUT=/dev/stderr; fi
ask() { # ask "Question" default -> REPLY
  local q="$1" def="${2:-}"
  if [[ -n "$def" ]]; then printf '  %s [%s]: ' "$q" "$def" >"$OUT"; else printf '  %s: ' "$q" >"$OUT"; fi
  IFS= read -r REPLY <"$IN" || REPLY=""
  REPLY="${REPLY#"${REPLY%%[![:space:]]*}"}"
  REPLY="${REPLY%"${REPLY##*[![:space:]]}"}"
  [[ -n "$REPLY" ]] || REPLY="$def"
}
yes_no() { # yes_no "Question" y|n -> true when yes
  ask "$1 (y/n)" "$2"
  [[ "$REPLY" =~ ^[Yy] ]]
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GW="$REPO/gateway"
ENV_FILE="$GW/.env"
SERVICE=backup-gateway
TUNNEL_SERVICE=backup-gateway-tunnel

[[ $EUID -eq 0 ]] || die "Run it with sudo:  sudo bash deploy/install.sh"
[[ -f "$GW/src/index.js" ]] || die "Run it from the backup-gateway folder (deploy/install.sh inside it)."
command -v systemctl >/dev/null || die "This computer doesn't use systemd, which the gateway service needs."
if command -v apt-get >/dev/null; then PKG=apt
elif command -v pacman >/dev/null; then PKG=pacman
else die "This script works on Ubuntu, Debian and Arch (Omarchy)."
fi

# The user who cloned the project runs the gateway (never root)
APP_USER="$(stat -c %U "$REPO")"
[[ "$APP_USER" != "root" ]] ||
  die "The project folder belongs to root. Clone it as your normal user (not with sudo), then run this again."
as_app() { sudo -u "$APP_USER" -H bash -c "cd '$1' && $2"; }

env_get() { [[ -f "$ENV_FILE" ]] && grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true; }
env_set() { # replaces KEY=… (or a commented "# KEY=…"), or adds it
  if grep -qE "^#? ?$1=" "$ENV_FILE"; then
    sed -i -E "s|^#? ?$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
lan_ip() {
  local a=""
  command -v ip >/dev/null && a="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -n 1 || true)"
  [[ -n "$a" ]] || a="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  echo "$a"
}
public_ip() { curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || lan_ip; }

echo
printf '\e[1mBackup gateway install\e[0m (project %s, runs as %s)\n' "$REPO" "$APP_USER"

# ---------------------------------------------------------------------
step "1/7 Tools and Node.js 22"
if [[ $PKG == apt ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git tar >/dev/null
else
  pacman -S --needed --noconfirm curl ca-certificates git tar >/dev/null
fi
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; }
if ! node_ok; then
  if [[ $PKG == apt ]]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    pacman -S --needed --noconfirm nodejs-lts-jod npm >/dev/null
  fi
fi
node_ok || die "Node.js 22.13 or newer is needed, and couldn't be installed (this computer has $(node -v 2>/dev/null || echo none))."
NODE="$(command -v node)"
ok "Node.js $(node -v), git, curl"

# ---------------------------------------------------------------------
step "2/7 Antivirus (ClamAV)"
clamd_running() { systemctl is-active --quiet clamav-daemon 2>/dev/null; }
if clamd_running; then
  ok "ClamAV already running"
else
  MEM_MB=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo)
  INSTALL_CLAM=yes
  if (( MEM_MB < 2500 )); then
    warn "This computer has ${MEM_MB} MB of memory. ClamAV needs about 1.5 GB of its own."
    yes_no "Install ClamAV anyway? Without it, files are only checked for ransomware signs" n || INSTALL_CLAM=no
  fi
  if [[ $INSTALL_CLAM == yes ]]; then
    if [[ $PKG == apt ]]; then
      apt-get install -y -qq clamav clamav-daemon >/dev/null
    else
      pacman -S --needed --noconfirm clamav >/dev/null
      # Arch ships clamd.conf with its socket commented out
      sed -i -E 's|^#?LocalSocket .*|LocalSocket /run/clamav/clamd.ctl|' /etc/clamav/clamd.conf
      grep -q '^LocalSocket ' /etc/clamav/clamd.conf || echo 'LocalSocket /run/clamav/clamd.ctl' >>/etc/clamav/clamd.conf
    fi
    echo "  Downloading the virus signatures (a minute or two the first time)..."
    systemctl stop clamav-freshclam >/dev/null 2>&1 || true
    freshclam --quiet || warn "freshclam didn't finish; the signature service tries again by itself"
    systemctl enable --now clamav-freshclam >/dev/null 2>&1 || true
    systemctl enable --now clamav-daemon >/dev/null 2>&1 || true
    sleep 3
    if clamd_running; then ok "ClamAV running: every backup is scanned"
    else warn "ClamAV is installed but not running yet (it starts once the signatures are in). The Security page shows its state."
    fi
  else
    warn "Skipped. Install it later with this script, or: see README, Antivirus"
  fi
fi

# ---------------------------------------------------------------------
step "3/7 Settings and where the backups are kept"
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$GW/.env.example" "$ENV_FILE"
  ok "Made gateway/.env"
fi
DATA_DIR="$(env_get GATEWAY_DATA_DIR)"
if [[ -z "$DATA_DIR" || "$DATA_DIR" == "./data" ]] && [[ ! -f "$GW/data/gateway.db" ]]; then
  echo "  The backups and the gateway's database go in one folder. Pick a disk with plenty of space."
  ask "Folder for the backups" "$GW/data"
  DATA_DIR="$REPLY"
  [[ "$DATA_DIR" == /* ]] || die "Give the full path, starting with /"
  env_set GATEWAY_DATA_DIR "$DATA_DIR"
fi
[[ "$DATA_DIR" == /* ]] || DATA_DIR="$GW/${DATA_DIR#./}"
mkdir -p "$DATA_DIR"
chown "$APP_USER:" "$DATA_DIR"
chmod 700 "$DATA_DIR"
PORT="$(env_get GATEWAY_PORT)"; PORT="${PORT:-8080}"
ok "Backups kept in $DATA_DIR ($(df -h --output=avail "$DATA_DIR" | tail -n 1 | tr -d ' ') free)"

# ---------------------------------------------------------------------
step "4/7 How devices reach the gateway"
CURRENT_URL="$(env_get GATEWAY_PUBLIC_URL)"
echo "  1) Online: a cloud VM, or a machine on site (you add the domain afterwards, on the web UI)"
echo "  2) This network only (testing)"
DEFAULT_MODE=1
[[ "$CURRENT_URL" == http://* ]] && DEFAULT_MODE=2
ask "Choose 1 or 2" "$DEFAULT_MODE"
MODE="$REPLY"
[[ "$MODE" =~ ^[12]$ ]] || die "Choose 1 or 2."

if [[ $MODE == 1 ]]; then
  # The gateway only listens on this computer: Caddy or the tunnel bring devices to it.
  # The address itself is set on the Certificate page (it's kept in the gateway's database).
  env_set GATEWAY_HOST 127.0.0.1
  env_set GATEWAY_PUBLIC_URL ""
  env_set GATEWAY_TRUST_PROXY 1
  ok "Online. The address is added on the web UI's Certificate page"
else
  IP="$(lan_ip)"
  ask "This computer's address on the network" "$IP"
  IP="$REPLY"
  env_set GATEWAY_HOST 0.0.0.0
  env_set GATEWAY_PUBLIC_URL "http://$IP:$PORT"
  env_set GATEWAY_TRUST_PROXY ""
  ok "Devices on this network will use http://$IP:$PORT"
fi
# The web UI never leaves this computer
env_set GATEWAY_ADMIN_HOST 127.0.0.1
chown "$APP_USER:" "$ENV_FILE"
chmod 600 "$ENV_FILE"
ok "gateway/.env saved (only $APP_USER can read it)"

# ---------------------------------------------------------------------
step "5/7 Web UI and the gateway service"
as_app "$GW/ui" "npm ci --no-audit --no-fund --loglevel=error" >/dev/null
as_app "$GW/ui" "npm run build" >/dev/null
ok "Web UI built"

# Something already on the gateway's ports (e.g. "npm start" left running in a terminal)?
if ! systemctl is-active --quiet "$SERVICE" && (ss -ltn 2>/dev/null | grep -qE ":($PORT|8090)\b"); then
  warn "Something is already using port $PORT or 8090 (a gateway started with npm start?). Stop it (Ctrl+C), then press Enter."
  read -r <"$IN" || true
fi

cat >/etc/systemd/system/$SERVICE.service <<EOF
# The backup gateway (made by deploy/install.sh). Logs: journalctl -u $SERVICE -f
[Unit]
Description=Backup gateway
After=network-online.target clamav-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$GW
ExecStart=$NODE --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/index.js
Restart=always
RestartSec=5
UMask=0077
# It can only write to its backups folder; the rest of the system is read-only to it
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
systemctl restart "$SERVICE"
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:8090/ 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null http://127.0.0.1:8090/ ||
  die "The gateway didn't start. See why with:  journalctl -u $SERVICE -n 50"
ok "Gateway running as a service: starts on boot, restarts if it stops"

# ---------------------------------------------------------------------
step "6/7 Caddy, cloudflared and the firewall"
ufw_on() { command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; }

CADDY_OTHER=no
if [[ $MODE == 1 ]]; then
  # --- cloudflared: the gateway runs it itself when you choose a Cloudflare Tunnel ---
  if ! command -v cloudflared >/dev/null; then
    if [[ $PKG == apt ]]; then
      mkdir -p /usr/share/keyrings
      curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
      echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
        >/etc/apt/sources.list.d/cloudflared.list
      apt-get update -qq
      apt-get install -y -qq cloudflared >/dev/null
    else
      pacman -S --needed --noconfirm cloudflared >/dev/null
    fi
  fi
  ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}' || true) (for a Cloudflare Tunnel)"
  # Earlier versions of this script ran their own tunnel service: the gateway runs it now
  if [[ -f /etc/systemd/system/$TUNNEL_SERVICE.service ]]; then
    systemctl disable --now "$TUNNEL_SERVICE" >/dev/null 2>&1 || true
    rm -f /etc/systemd/system/$TUNNEL_SERVICE.service
    systemctl daemon-reload
  fi

  # --- Caddy: https with its own certificate, for a server with a public IP ---
  # The gateway gives Caddy its settings itself (Caddy's admin API, on this computer only).
  MARK="# backup-gateway (made by deploy/install.sh)"
  if ! grep -qF "$MARK" /etc/caddy/Caddyfile 2>/dev/null; then
    grep -qE '^[^#]*reverse_proxy' /etc/caddy/Caddyfile 2>/dev/null && CADDY_OTHER=yes
  fi
  if [[ $CADDY_OTHER == yes ]]; then
    warn "Caddy is already used here for something else (Uplink?), so it's left as it is."
    warn "On this server, choose \"On site, with a Cloudflare Tunnel\" on the Certificate page."
  else
    if ! command -v caddy >/dev/null; then
      if [[ $PKG == apt ]]; then
        apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
          gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
        curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
        chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
        apt-get update -qq
        apt-get install -y -qq caddy >/dev/null
      else
        pacman -S --needed --noconfirm caddy >/dev/null
      fi
    fi
    mkdir -p /etc/caddy
    cat >/etc/caddy/Caddyfile <<CADDYFILE
$MARK
# Empty on purpose: the backup gateway gives Caddy its settings (the address you add on
# its Certificate page) through Caddy's admin API, which only listens on this computer.
{
    admin localhost:2019
}
CADDYFILE
    systemctl enable caddy >/dev/null 2>&1
    systemctl restart caddy
    ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}' || true) (for your domain with its own certificate)"
  fi

  if ufw_on; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    ok "Firewall: ports 80 and 443 open (needed with your own IP, not with a tunnel)"
  fi
else
  if ufw_on; then ufw allow "$PORT/tcp" >/dev/null; ok "Firewall: port $PORT open"; fi
  ok "Nothing else to connect"
fi

# ---------------------------------------------------------------------
step "7/7 Your admin account and the update-gateway command"
if as_app "$GW" "$NODE --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/cli/has-admin.js" >/dev/null 2>&1; then
  ok "The web UI already has an admin account"
else
  ask "Username for the web UI" "$APP_USER"
  ADMIN_NAME="$REPLY"
  [[ "$ADMIN_NAME" =~ ^[A-Za-z0-9._-]{3,40}$ ]] || { warn "Usernames are 3-40 letters, numbers, dots, dashes or underscores."; ADMIN_NAME="$APP_USER"; }
  MADE=no
  for _ in 1 2 3; do
    if as_app "$GW" "$NODE --disable-warning=ExperimentalWarning --env-file-if-exists=.env src/cli/create-admin.js '$ADMIN_NAME'" <"$IN"; then
      MADE=yes
      break
    fi
    echo "  Let's try that again."
  done
  [[ $MADE == yes ]] || warn "No admin made yet. Later:  cd $GW && npm run create-admin -- $ADMIN_NAME"
fi

cat >/usr/local/bin/update-gateway <<EOF
#!/usr/bin/env bash
# Gets the newest gateway from GitHub and restarts it (made by deploy/install.sh)
set -euo pipefail
if [[ \$(id -un) != "$APP_USER" ]]; then exec sudo -u "$APP_USER" -H "\$0" "\$@"; fi
cd "$REPO"
git pull --ff-only
cd gateway/ui
npm ci --no-audit --no-fund --loglevel=error
npm run build
sudo systemctl restart $SERVICE
echo "Updated and restarted. Logs: journalctl -u $SERVICE -f"
EOF
chmod 755 /usr/local/bin/update-gateway
ok "update-gateway: gets the newest version and restarts"

# ---------------------------------------------------------------------
echo
printf '\e[32m%s\e[0m\n' "Done. The gateway is installed and running."
echo
echo "Open the web UI:"
if [[ -n "${SSH_CONNECTION:-}" || $MODE == 1 ]]; then
  echo "  From your laptop, connect with this (leave it open), then go to http://127.0.0.1:8090"
  echo
  printf '      \e[1mssh -L 8090:127.0.0.1:8090 %s@%s\e[0m\n' "$APP_USER" "$(public_ip)"
  echo
  echo "  (On this computer itself: http://127.0.0.1:8090)"
else
  echo "  http://127.0.0.1:8090 on this computer"
fi
echo
if [[ $MODE == 1 ]]; then
  echo "Then, to put it online: open Certificate (under More), and either"
  echo "  - This server has its own IP: enter your domain, add the DNS record it shows, Get certificate"
  if [[ $CADDY_OTHER == yes ]]; then
    echo "    (not on this server: its Caddy belongs to something else)"
  else
    echo "    (your cloud provider's firewall must allow ports 80 and 443)"
  fi
  echo "  - On site, with a Cloudflare Tunnel: make a tunnel on Cloudflare, paste its token, Connect"
  echo "Once it says \"Secure, in use\", add devices: Devices > Add device."
else
  echo "Devices on this network connect to $(env_get GATEWAY_PUBLIC_URL). Add one: Devices > Add device."
fi
echo "Check on it:  systemctl status $SERVICE    Logs:  journalctl -u $SERVICE -f"
