#!/usr/bin/env bash
# Removes the backup agent service from this Linux computer.
#
#   sudo ./uninstall.sh           remove the agent, but keep its identity and settings
#                                 (installing again later carries on as the same device)
#   sudo ./uninstall.sh --purge   also delete its identity, keys and settings. The device can't
#                                 reconnect after this; to back it up again, enroll it with a new code.
#
# Backups already on the gateway are never touched by this. Remove the device in the web UI too
# if it's gone for good.

set -euo pipefail

SERVICE=backup-agent
APP_USER=backup-agent

PURGE=no
case "${1-}" in
  "") ;;
  --purge) PURGE=yes ;;
  -h | --help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "Unknown option: $1 (use --purge or nothing)" >&2; exit 1 ;;
esac

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }

systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f /etc/systemd/system/$SERVICE.service /etc/sysctl.d/90-backup-agent.conf
systemctl daemon-reload 2>/dev/null || true
rm -rf /opt/backup-agent
echo "Removed the $SERVICE service and its code."

if [ "$PURGE" = yes ]; then
  rm -rf /var/lib/backup-agent /etc/backup-agent
  userdel "$APP_USER" 2>/dev/null || true
  echo "Deleted the device's identity, keys and settings."
else
  echo "Kept the device's identity (/var/lib/backup-agent) and settings (/etc/backup-agent)."
  echo "Run with --purge to delete those too."
fi
