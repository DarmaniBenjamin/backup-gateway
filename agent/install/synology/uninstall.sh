#!/bin/bash
# Removes the backup agent from this Synology NAS. A copy is kept with the installed agent:
#
#   sudo /volume1/@backup-agent/app/install/synology/uninstall.sh           remove the agent, keep its
#        identity and settings (installing again later carries on as the same device)
#   sudo /volume1/@backup-agent/app/install/synology/uninstall.sh --purge   also delete its identity,
#        keys and settings. The NAS can't reconnect after this; add it again to back it up.
#
# Backups already on the gateway are never touched by this. Remove the device in the web UI too
# if it's gone for good.

set -euo pipefail

main() {
  local SERVICE=backup-agent
  local UNIT=/etc/systemd/system/$SERVICE.service
  local PURGE=no
  case "${1-}" in
    "") ;;
    --purge) PURGE=yes ;;
    -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (use --purge or nothing)" >&2; exit 1 ;;
  esac
  [ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

  # Where it's installed: from the service, or from where this script is
  local PREFIX=""
  [ -f "$UNIT" ] && PREFIX=$(sed -n 's/^WorkingDirectory=\(.*\)\/app$/\1/p' "$UNIT" | head -n1)
  if [ -z "$PREFIX" ]; then
    local here
    here=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
    case "$here" in /volume[0-9]*/@backup-agent) PREFIX=$here ;; esac
  fi
  if [ -z "$PREFIX" ]; then
    # Already uninstalled once (identity kept): find what's left on the volumes
    local d
    for d in /volume[0-9]*/@backup-agent; do [ -d "$d" ] && PREFIX=$d && break; done
  fi
  case "$PREFIX" in /volume[0-9]*/@backup-agent) ;; *) echo "Couldn't find the installed agent." >&2; exit 1 ;; esac

  systemctl disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl daemon-reload 2>/dev/null || true
  rm -rf "$PREFIX/app" "$PREFIX/node" "$PREFIX/agent.log"*
  echo "Removed the $SERVICE service and its code."

  if [ "$PURGE" = yes ]; then
    rm -rf "$PREFIX"
    echo "Deleted the device's identity, keys and settings."
  else
    echo "Kept the device's identity ($PREFIX/data) and settings ($PREFIX/agent.env)."
    echo "Run with --purge to delete those too."
  fi
}

main "$@"
