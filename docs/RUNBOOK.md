# Backup gateway runbook

For the bad day. Fill in the blanks, then keep a copy somewhere you can reach **without** the
gateway: a password manager, or printed in a safe place. Never write the secrets themselves in this
file or in the repo; write where they are.

## Where things are

| What | Where it's kept |
| --- | --- |
| Recovery key (`BGRK-…`): opens every off-site copy, lifts lockdown | |
| Two-factor recovery codes (web UI) | |
| Web UI admin username | |
| Server login (Linode account, SSH key) | |
| Domain and DNS provider login | |
| Backblaze / S3 accounts and bucket names | |
| Google account used for Drive copies | |
| Alerts (ntfy topic) | |

| Server facts | |
| --- | --- |
| Web UI | `https://` |
| Server IP | |
| Repo folder on the server | |
| Backups folder (`GATEWAY_DATA_DIR`) | |

## Everyday

```bash
update-gateway                                  # newest version, rebuild, restart
systemctl status backup-gateway                 # is it running?
journalctl -u backup-gateway -f                 # its log, live
systemctl status clamav-daemon                  # the antivirus
cd <repo>/gateway && npm test                   # the tests
```

## When something goes wrong

**Can't sign in: lost phone.** Use one of the recovery codes in place of the 6-digit code. Then, on
the Account page, turn two-factor off and on again with the new phone (or make new recovery codes).

**Can't sign in: lost phone and recovery codes.** On the server, in the gateway folder:

```bash
sudo npm run reset-2fa -- <username>
```

**Forgot the password.** On the server, in the gateway folder: `npm run create-admin -- <username>`
sets a new one.

**Lockdown is on.** First find out why: the Security page and the Alerts page say what triggered it.
If it was an attack, change the admin password and check two-factor is on before lifting it. Lift it
on the Security page with the recovery key, or without it, on the server:

```bash
sudo npm run lockdown -- status
sudo npm run lockdown -- off
```

**Web UI unreachable by its domain.** Check the server is up, then the Domain & SSL page from the
server itself (the setup link: `sudo npm run setup-link` in the gateway folder). Common causes: the
DNS record changed, or ports 80/443 closed in the cloud firewall.

**Antivirus not running.** The Security page says why. `systemctl status clamav-daemon`, and
`free -m` for memory (ClamAV needs about 1.5 GB of its own).

**A device stopped backing up.** Its page shows when it was last seen. On the device:
- Windows: Task Scheduler, task "BackupAgent"; log: `C:\ProgramData\BackupAgent\agent.log`
- Linux: `systemctl status backup-agent`, `journalctl -u backup-agent -f`
- Synology: `/volume1/@backup-agent/agent.log`

**Ransomware on a client's device.** The gateway freezes the device when it sees the signs (Security
page). Don't unfreeze until the device is cleaned. Restore from versions before the attack (Restore
page, pick the date). Locked off-site copies can't be changed by the attacker.

## The gateway server is lost

Rebuild it on a new server from an off-site copy, with the recovery key:

1. New server, then the installer: `sudo bash deploy/install.sh`
2. Stop the gateway: `sudo systemctl stop backup-gateway`
3. Recover into its backups folder:

   ```bash
   cd <repo>/gateway
   npm run recover -- --endpoint <s3 endpoint> --bucket <bucket> --key-id <key id> --to <backups folder>
   ```

4. Start it: `sudo systemctl start backup-gateway`, then set up Domain & SSL again. Devices find it
   at the same domain by themselves.

Practise this once on a spare server before you need it.
