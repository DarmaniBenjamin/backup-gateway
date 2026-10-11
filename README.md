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

## Adding a device

In the web UI, go to **Devices → Add device**, pick the client and the kind of device, and enter the
folders it may back up. You get one command to paste in a terminal on the new device, for example:

```bash
(curl -fsSL 'http://192.168.1.10:8080/install/…/linux.sh' || wget -qO- '…') | sudo bash
```

It downloads the agent from the gateway, checks its SHA-256, installs it as a background service and
connects — no code or settings to type. The command works once and expires with its enrollment code.
For devices on other computers, set `GATEWAY_HOST=0.0.0.0` and `GATEWAY_PUBLIC_URL` in the gateway's `.env`.

On Linux the agent runs as a service (`backup-agent`) under its own user, not root. It can read any
file so it can back it up, but can only write inside the allowed folders (for restores), and the rest
of the system is read-only to it. To remove it: `sudo /opt/backup-agent/uninstall.sh` (add `--purge`
to also delete the device's identity). Windows, Mac and Synology installers are coming.

## Status

Early development — running locally.