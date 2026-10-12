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
folders it may back up. You get a short link to type into a browser on the new device, and one
command to paste in a terminal there, for example:

    http://192.168.1.10:8080/i/K7Q2MX
    curl -fsSL http://192.168.1.10:8080/i/K7Q2MX/sh | sudo bash

It downloads the agent from the gateway, checks its SHA-256, installs it as a background service and
connects — no code or settings to type. The link works once and expires with its enrollment code
(after 20 wrong links in 10 minutes, an address has to wait, so the 6-letter codes can't be guessed).
For devices on other computers, set `GATEWAY_HOST=0.0.0.0` and `GATEWAY_PUBLIC_URL` in the gateway's `.env`.

**Windows PCs and servers** get three choices: the setup program, or one command for PowerShell or
Command Prompt run as Administrator. All three do the same:
the agent goes to `C:\Program Files\BackupAgent`, its settings and keys to `C:\ProgramData\BackupAgent`
(SYSTEM and Administrators only), and it runs as a background task that starts with Windows. To remove
it: `powershell -ExecutionPolicy Bypass -File "C:\Program Files\BackupAgent\uninstall.ps1"` (add
`-Purge` to also delete the device's identity). Files that another program keeps locked (Outlook
`.pst`, QuickBooks, Access databases) are read from a Volume Shadow Copy of the drive, which the agent
takes when it needs one and removes a few minutes later.

### The Windows setup program

`BackupAgentSetup.exe` comes with the gateway (source: `gateway/setup-exe/setup.c` and `setup.rc`).
It's the same file for every device: which install it's for is in its name, set by the gateway when
it's downloaded (`BackupAgentSetup_K7Q2MX_192.168.1.10_8080.exe`). Renamed, it asks for the short link.
It asks for administrator rights, gets the install's details from the gateway, downloads the agent and
checks its SHA-256, unpacks it with Windows' own `tar.exe`, and runs `install.ps1`. Nothing is added
to the file and it doesn't run code straight from the internet, which is what antivirus programs look
for in malware.

Rebuild it after changing those files with `npm run build-windows-setup` (needs Zig:
`sudo pacman -S zig`), then restart the gateway.

Until it's code-signed, Windows SmartScreen says it "protected your PC" (More info > Run anyway), and
some antivirus programs are wary of any new unsigned program. Signing it removes that: get a code
signing certificate (for example Azure Trusted Signing, or a certificate from Certum, Sectigo or
DigiCert), sign `gateway/setup-exe/BackupAgentSetup.exe`, keep the signed file there and restart the
gateway. Every device then gets that signed file, since it's the same for everyone. If one antivirus
still flags it, send the file to that vendor as a false positive (Microsoft:
https://www.microsoft.com/wdsi/filesubmission).

On Linux the agent runs as a service (`backup-agent`) under its own user, not root. It can read any
file so it can back it up, but can only write inside the allowed folders (for restores), and the rest
of the system is read-only to it. To remove it: `sudo /opt/backup-agent/uninstall.sh` (add `--purge`
to also delete the device's identity).

**Synology NAS (DSM 7 or newer):** turn on SSH (Control Panel > Terminal & SNMP), connect with an
administrator account and paste the command. Allowed folders are shared folders, like
`/volume1/Clients`. Everything goes on the data volume in `/volumeN/@backup-agent` (not a shared
folder, and DSM updates leave it alone): the agent, Node.js (Package Center's Node.js v22 is used if
it's installed), settings, keys and the log. If a big DSM update removes the service, run
`sudo /volume1/@backup-agent/app/install/synology/install.sh` to put it back; `uninstall.sh` next to
it removes the agent (add `--purge` to also delete its identity). A Mac installer is coming.

**Full access and the folder lock.** Normally a device only lets the gateway see the allowed folders
given at install. Tick **Full access** in Add device instead to see every folder on the device (every
drive, hidden and system folders too), back up anything and restore anywhere. The device's own data
and log, and on Linux `/proc`, `/sys`, `/dev`, `/run` and `/tmp`, are always skipped. Full access can
only be chosen at install (`AGENT_ALLOWED_PATHS="*"`); the gateway can't switch it on.

Once the folders are right, click **Lock folders** on the device's page. The gateway shows an unlock
key once (`BGFL-…`) and forgets it; the device keeps only a scrypt hash of it. While locked, the device
keeps backing up exactly those folders and refuses any other list, even from a hacked gateway. To
change them, click **Unlock** and enter the key: the device unlocks for 30 minutes, then locks again by
itself. Five wrong keys in a row block tries for 15 minutes.

## Off-site copies (Backblaze B2, other S3 storage, Google Drive)

Every clean backup can also go to the cloud. Everything sent is already encrypted, and quarantined
files are never sent. There are two kinds of copy:

- **Failsafe** (on the **Off-site** page): one location that gets everything, from every device.
  **Back up everything now** sends whatever it doesn't have yet straight away.
- **A device's own copies** (on each device's page, under **Off-site copies**): its own Backblaze
  bucket with its own application key, and/or its own Google Drive. Each backup folder on the device
  page picks which of the device's copies it goes to (all of them by default).

A bucket must have **Object Lock** turned on (Backblaze B2, Wasabi, Amazon S3 or any S3-compatible
storage). Backups are locked there for the number of days you choose, so nobody can delete or change
them before then: not ransomware, not someone with the gateway's key. Google Drive can't lock files,
so use a locked bucket as the failsafe.

### Google Drive

Set up Google sign-in once (Off-site page, **Google sign-in setup**). In https://console.cloud.google.com:

1. Make a project. In **APIs & Services > Library**, turn on the **Google Drive API** and the
   **Google Picker API**.
2. **Google Auth Platform**: External, app name and your email; then under **Audience** click
   **Publish app** ("In production"). In "Testing", Google drops the sign-in after 7 days.
3. **Clients > Create client**, type **Desktop app**. Copy the client ID and client secret.
4. **APIs & Services > Credentials > Create credentials > API key**, restricted to the Google Picker
   API. Copy it, and the **project number** from the project's dashboard.

After that, adding a Google Drive (to the failsafe or a device) is: **Sign in with Google**, then
choose where the backups go: a new folder (in My Drive or inside a folder you pick) or a folder
that's already in the Drive. The gateway only gets access to the files it makes and the folders you
pick (drive.file), nothing else in the account. Do it in a browser on the gateway computer
(127.0.0.1): Google sends you back there.

### Recovery key

The first copy you connect gives you a **recovery key** (`BGRK-…`), shown once; it opens every copy.
Keep it offline. If the gateway is ever lost, rebuild it on a new machine:

```bash
cd gateway
# from a bucket (the failsafe, or a device's own)
npm run recover -- --endpoint s3.us-west-004.backblazeb2.com --bucket YOUR-BUCKET --key-id YOUR-KEY-ID --to ./data
# from a Google Drive copy: download its "Backup Gateway - …" folder and unzip it all into one folder
npm run recover -- --from-folder ./backup-gateway-drive --to ./data
```

It asks for the keys, then downloads and checks every backup. A device's own copy rebuilds a gateway
with just that device in it.

## Antivirus and the Security page

Every file version that arrives is scanned with ClamAV (free) while the gateway rebuilds and checks
it, so the decrypted file never touches the disk. Malware is held in quarantine like the ransomware
checks do: it's never restored or sent off-site. Install ClamAV on the gateway computer:

    sudo pacman -S clamav                                     # Arch / Omarchy
    sudo freshclam
    sudo systemctl enable --now clamav-freshclam clamav-daemon

(On Debian or Ubuntu: sudo apt install clamav-daemon.) The gateway finds it by itself; backups that
arrived before it was installed are scanned in the background. When ClamAV gets new signatures, the
last 7 days of backups are scanned again, to catch malware that was too new to recognise at first.

The **Security** page shows it live: the overall status, files scanned, malware and ransomware
signs found, a timeline, top detections, devices by risk, and a feed of every security event (click
one for its details). Rescans can be started there too.

## Agent updates

The gateway offers its agent version to every device running an older one: a few devices at a
time, and only updates signed by the gateway's own update key are installed. On each device a
separate updater (root on Linux and Synology, SYSTEM on Windows) checks the signature, installs the
new version beside the old one, and puts the old one back if the new one doesn't connect within two
minutes. Turn automatic updates off on the Devices page, or hold one device at its version.

Agents installed before 0.15 don't have the updater yet: on the device's page, **Turn on automatic
updates** gives a one-time command for it (it keeps the device's identity, folders and settings).

## Alerts (phone push, email, webhook)

The **Alerts** page sends security events and problems where you'll see them: a phone
notification through the free ntfy app (iPhone and Android), email through any mail server
(Gmail with an app password, Microsoft 365, or a relay), or a webhook (Slack, Discord, or JSON for
your own systems, signed with HMAC-SHA256 if you set a secret). Each place has its own minimum
severity and kinds of events, and a Send test button.

Besides malware and ransomware signs, the gateway also warns when a device hasn't checked in for a
while (24 hours by default), when it's back, when an off-site copy keeps failing, and when the
gateway's disk is nearly full. Events close together are sent as one message.

## Pausing, uninstalling and removing a device

On a device's page, **Service**:

- **Pause backups** stops sending new changes (everything already backed up is kept).
- **Uninstall agent** removes the agent from the device by itself, in the background: its service,
  program, keys and settings. The device's own files aren't touched. If the device is offline, it
  does it the next time it connects. The order is signed with the gateway's update key and checked
  by the device's updater. A device with its folder lock on waits until it's unlocked with its key.
  Its backups stay on the gateway and can still be restored to another device.
- **Remove device** cuts off a computer that's gone or broken, without uninstalling anything.

Removed devices are listed at the bottom of the Devices page. **Delete for good** deletes one and its
backups from the gateway. Or let it happen by itself: **Delete a removed device and its backups**
(7 days to a year after it's removed, or never, the default). An alert goes out 3 days before, and
**Keep its backups** on the device's page stops it for that device. Copies already sent off-site
aren't deleted from the cloud: they stay until their lock runs out (and the bucket's lifecycle rule
clears them), or, on Google Drive, until you delete the folder.

## Synology DSM settings

On a Synology, the agent exports the DSM settings (users, groups, shared folders and their
permissions, network, services) once a day with Synology's own tool into
`/volume1/@backup-agent/DSM-settings/dsm-settings.dss`. On the device page, **Back up DSM settings**
adds that folder, so every day's export is kept as a version. To put settings back: DSM, Control
Panel > Update & Restore > Configuration Backup > Restore, with the restored .dss file.

## Status

Early development — running locally.