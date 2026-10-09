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

## Status

Early development — running locally.