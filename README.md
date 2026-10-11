# Backup Gateway

Secure off-site backup system for client devices (Synology NAS, Windows/Linux PCs).

## How it works

Client device (agent) → Gateway (versions, checks, quarantine) → Backblaze B2 / Google Drive

- **agent/** — lightweight app installed on the client device. Watches folders for changes and sends them to the gateway. Only makes outgoing connections — no port forwarding needed at the client.
- **gateway/** — central server. Receives files, keeps versions, scans for viruses and ransomware signs, quarantines suspect files, and uploads clean versions to cloud storage with Object Lock.

## Security principles

- Encrypted everywhere: TLS in transit, AES-256 at rest and before upload
- Each agent has its own identity and can only upload — never read or delete
- Cloud backups are immutable (Object Lock)
- Gateway is replaceable: reinstall + recovery key = full recovery

## Installing the agent on a Linux PC or server

1. In the web UI, go to **Devices → Add device** and create an enrollment code.
2. Copy this project's `agent` folder onto the device (for example with `git clone`).
3. From the folder that contains it, run the command shown in the web UI:

   ```bash
   sudo ./agent/install/linux/install.sh --gateway http://GATEWAY-ADDRESS:8080 --code YOUR-CODE --allowed "/home;/srv/shared"
   ```

   `--allowed` lists the only folders the gateway may ever back up or browse on that device.

The agent runs as a background service (`backup-agent`) under its own user, not root. It can read
any file so it can back it up, but can only write inside the allowed folders (for restores), and the
rest of the system is read-only to it. To upgrade, run the installer again from a newer copy with no
options. To remove it: `sudo ./agent/install/linux/uninstall.sh` (add `--purge` to also delete the
device's identity).

## Status

Early development — running locally.