// One-line installs: "Add device" in the web UI creates an install link that carries everything
// the new device needs (gateway address, enrollment code, allowed folders, name). On the device
// you paste one command (or run the setup .exe on Windows); it downloads a small script from the
// link, which downloads the agent package, checks its SHA-256 and runs the installer with those
// settings.
//
// Each link also has a short form, easy to type on the new device: http://192.168.1.25:8080/i/K7Q2MX
//   /i/K7Q2MX              a page with the setup program and the command (for a browser)
//   /i/K7Q2MX/win          the Windows install script:  irm http://…/i/K7Q2MX/win | iex
//   /i/K7Q2MX/sh           the Linux or Synology one:   curl -fsSL http://…/i/K7Q2MX/sh | sudo bash
//   /i/K7Q2MX/setup.exe    BackupAgentSetup.exe, named BackupAgentSetup_K7Q2MX_<host>_<port>.exe
//   /i/K7Q2MX/setup.json   what the setup program asks for (package address, SHA-256, options)
// The setup program is the same file for everyone (see setup-exe/setup.c): its name says which
// install it is, so nothing is added to it and antivirus can trust it.
//
// Links live in memory only — the enrollment code inside them is never written to disk — and
// stop working when their device enrolls, when their code expires, or when the gateway restarts.

import crypto from "node:crypto";
import os from "node:os";
import { hashCode } from "./codes.js";
import { log } from "./logger.js";

export const PLATFORMS = ["linux", "windows", "synology"];

export class InstallError extends Error {}

// Short codes: no 0/O, 1/I/L, so they can't be misread or mistyped. 6 characters = 887 million,
// and guesses are limited (server.js), while a link only lives as long as its enrollment code.
export const SHORT_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SHORT_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
const newShortCode = () => Array.from({ length: 6 }, () => SHORT_ALPHABET[crypto.randomInt(SHORT_ALPHABET.length)]).join("");

// Text that ends up inside an install script. Linux: no quotes, backslashes, $ or control
// characters (bash). Windows: backslashes are fine (PowerShell single quotes), the rest isn't.
const SAFE = {
  linux: /^[^'"\\$`\u0000-\u001f\u007f]*$/,
  synology: /^[^'"\\$`\u0000-\u001f\u007f]*$/,
  windows: /^[^'"$`\u0000-\u001f\u007f]*$/,
};

const PATHS = {
  linux: {
    example: "/home",
    isFull: (p) => p.startsWith("/"),
    isRoot: (p) => p === "/",
    trim: (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p),
    inside: (child, parent) => child === parent || child.startsWith(`${parent}/`),
  },
  // Shared folders (or folders inside them) on a data volume; never a whole volume or DSM's own
  // @ and # folders
  synology: {
    example: "/volume1/Clients",
    notFull: "Allowed folders must be shared folders (or folders inside them) on a volume, like /volume1/Clients",
    isFull: (p) => /^\/volume[0-9]+\/[^/@#]/.test(p),
    isRoot: (p) => /^\/volume[0-9]+\/?$/.test(p),
    trim: (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p),
    inside: (child, parent) => child === parent || child.startsWith(`${parent}/`),
  },
  windows: {
    example: "C:\\Users",
    isFull: (p) => /^[A-Za-z]:\\/.test(p),
    isRoot: (p) => /^[A-Za-z]:\\?$/.test(p),
    // A trailing \ would break the quoting when the path is passed on, so it's removed
    trim: (p) => (/^[A-Za-z]:\\$/.test(p) ? p : p.replace(/\\+$/, "")),
    inside: (child, parent) => {
      const c = child.toLowerCase();
      const pa = parent.toLowerCase();
      return c === pa || c.startsWith(`${pa}\\`);
    },
  },
};

function cleanPathList(value, platform) {
  const rules = PATHS[platform];
  const list = String(value ?? "")
    .split(";")
    .map((p) => rules.trim(p.trim()))
    .filter(Boolean);
  if (list.length === 0) throw new InstallError(`Enter at least one allowed folder, e.g. ${rules.example}`);
  if (list.length > 20) throw new InstallError("At most 20 allowed folders.");
  for (const p of list) {
    if (rules.isRoot(p)) throw new InstallError(`A whole drive (${p}) can't be allowed. List the folders with data instead, e.g. ${rules.example}`);
    if (!rules.isFull(p)) throw new InstallError(`${rules.notFull ?? `Allowed folders must be full paths, like ${rules.example}`}: ${p}`);
    if (p.length > 500 || !SAFE[platform].test(p)) throw new InstallError(`This folder name can't be used: ${p}`);
  }
  return list.join(";");
}

export function cleanInstallOptions(body) {
  const platform = String(body.platform ?? "");
  if (!PLATFORMS.includes(platform)) throw new InstallError("This kind of device isn't supported yet.");
  const rules = PATHS[platform];
  // Full access: the whole device can be browsed and backed up, and restored to anywhere
  const fullAccess = body.fullAccess === true;
  const allowed = fullAccess ? "*" : cleanPathList(body.allowed, platform);
  const name = String(body.deviceName ?? "").trim();
  if (name.length > 64 || !SAFE.linux.test(name)) throw new InstallError("Device name: up to 64 characters, no quotes, \\ or $.");
  const watch = rules.trim(String(body.watch ?? "").trim());
  if (watch) {
    if (!rules.isFull(watch) || watch.length > 500 || !SAFE[platform].test(watch)) {
      throw new InstallError(`The first folder to back up must be a full path, like ${rules.example}.`);
    }
    if (!fullAccess && !allowed.split(";").some((a) => rules.inside(watch, a))) {
      throw new InstallError("The first folder to back up must be inside one of the allowed folders.");
    }
  }
  return { platform, allowed, fullAccess, name, watch };
}

// This computer's network addresses other devices could use (for the "only works here" message).
// Real network cards first; Docker, VM and VPN bridges last.
export function lanAddresses() {
  const virtual = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|zt|wg|tun|tap)/i;
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list ?? []).filter((i) => i.family === "IPv4" && !i.internal).map((i) => ({ name, address: i.address, virtual: virtual.test(name) })))
    .sort((a, b) => a.virtual - b.virtual)
    .map(({ name, address }) => ({ name, address }));
}

// The address devices use to reach the agent API
export function agentApiUrl(config) {
  if (config.publicUrl) return { url: config.publicUrl, localOnly: false };
  const host = config.host;
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") {
    return { url: `http://127.0.0.1:${config.port}`, localOnly: true };
  }
  if (host === "0.0.0.0" || host === "::") {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .find((i) => i && i.family === "IPv4" && !i.internal);
    if (lan) return { url: `http://${lan.address}:${config.port}`, localOnly: false };
    return { url: `http://127.0.0.1:${config.port}`, localOnly: true };
  }
  return { url: `http://${host.includes(":") ? `[${host}]` : host}:${config.port}`, localOnly: false };
}

const q = (s) => `'${s}'`; // safe: every value was checked against SAFE for its platform
const cleanName = (s) => s.replace(/[^\w .&()-]/g, "");

// The installer's options, as [option, value] pairs (value null for a switch). An upgrade (an
// enrolled device getting the self-updater) passes only the update key: the installer keeps
// everything else as it is. The key is base64 (safe in quotes).
function installerOptions({ code, options, gatewayUrl, updateKeyB64 }, win = false) {
  const o = (name) => (win ? `-${name[0].toUpperCase()}${name.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase())}` : `--${name}`);
  const opts = [];
  if (!options.upgrade) {
    opts.push([o("gateway"), gatewayUrl], [o("code"), code]);
    opts.push(options.fullAccess ? [win ? "-FullAccess" : "--full-access", null] : [o("allowed"), options.allowed]);
    if (options.name) opts.push([o("name"), options.name]);
    if (options.watch) opts.push([o("watch"), options.watch]);
  }
  if (updateKeyB64) opts.push([o("update-key"), updateKeyB64]);
  return opts;
}

// For a script: -Gateway 'http://…' -Code '…'
function installerArgs(params, win = false) {
  return installerOptions(params, win).map(([name, value]) => (value === null ? name : `${name} ${q(value)}`));
}

function linuxScript({ gatewayUrl, token, pkg, code, clientName, expiresAt, options, updateKeyB64 }) {
  const pkgUrl = `${gatewayUrl}/install/${token}/agent.tar.gz`;
  const args = installerArgs({ code, options, gatewayUrl, updateKeyB64 });
  return `#!/usr/bin/env bash
# Backup agent install for ${cleanName(clientName)}, made by the backup gateway.
# Works once, until ${expiresAt.toISOString()}.
set -euo pipefail

main() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run it with sudo: the command shown in the web UI ends with | sudo bash" >&2
    exit 1
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading the backup agent from the gateway..."
  if command -v curl >/dev/null; then
    curl -fsSL ${q(pkgUrl)} -o "$tmp/agent.tar.gz"
  elif command -v wget >/dev/null; then
    wget -qO "$tmp/agent.tar.gz" ${q(pkgUrl)}
  else
    echo "Neither curl nor wget is installed. Install one of them and run the command again." >&2
    exit 1
  fi
  # Only run the package if it's exactly the one the gateway made
  echo "${pkg.sha256}  $tmp/agent.tar.gz" | sha256sum -c --quiet - || {
    echo "The download failed its SHA-256 check. Nothing was installed." >&2
    exit 1
  }
  tar -xzf "$tmp/agent.tar.gz" -C "$tmp" --no-same-owner
  bash "$tmp/agent/install/linux/install.sh" \\
    ${args.join(" \\\n    ")} </dev/null
}

main "$@"
`;
}

// The same as Linux, with the Synology installer (DSM 7: Node.js and everything else go on the data
// volume, which DSM updates leave alone)
function synologyScript({ gatewayUrl, token, pkg, code, clientName, expiresAt, options, updateKeyB64 }) {
  const pkgUrl = `${gatewayUrl}/install/${token}/agent.tar.gz`;
  const args = installerArgs({ code, options, gatewayUrl, updateKeyB64 });
  return `#!/bin/bash
# Backup agent install for ${cleanName(clientName)} (Synology NAS), made by the backup gateway.
# Works once, until ${expiresAt.toISOString()}.
set -euo pipefail

main() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "Run it with sudo: the command shown in the web UI ends with | sudo bash" >&2
    exit 1
  fi
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT

  echo "Downloading the backup agent from the gateway..."
  if command -v curl >/dev/null; then
    curl -fsSL ${q(pkgUrl)} -o "$tmp/agent.tar.gz"
  else
    wget -qO "$tmp/agent.tar.gz" ${q(pkgUrl)}
  fi
  # Only run the package if it's exactly the one the gateway made
  if command -v sha256sum >/dev/null; then
    sum=$(sha256sum "$tmp/agent.tar.gz" | cut -d' ' -f1)
  else
    sum=$(openssl dgst -sha256 -r "$tmp/agent.tar.gz" | cut -d' ' -f1)
  fi
  if [ "$sum" != "${pkg.sha256}" ]; then
    echo "The download failed its SHA-256 check. Nothing was installed." >&2
    exit 1
  fi
  tar -xzf "$tmp/agent.tar.gz" -C "$tmp" --no-same-owner
  bash "$tmp/agent/install/synology/install.sh" \\
    ${args.join(" \\\n    ")} </dev/null
}

main "$@"
`;
}

// Run with "irm … | iex", so it never calls exit (that would close the person's PowerShell
// window); the real installer runs as its own powershell.exe and reports back with its exit code.
function windowsScript({ gatewayUrl, token, pkg, code, clientName, expiresAt, options, updateKeyB64 }) {
  const pkgUrl = `${gatewayUrl}/install/${token}/agent.zip`;
  const args = installerArgs({ code, options, gatewayUrl, updateKeyB64 }, true);
  return `# Backup agent install for ${cleanName(clientName)}, made by the backup gateway.
# Works once, until ${expiresAt.toISOString()}.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host 'Run this in PowerShell or Command Prompt opened as Administrator (right-click > Run as administrator).' -ForegroundColor Red
    return
  }
  $tmp = Join-Path $env:TEMP ('backup-agent-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host 'Downloading the backup agent from the gateway...'
    Invoke-WebRequest -UseBasicParsing -Uri ${q(pkgUrl)} -OutFile (Join-Path $tmp 'agent.zip')
    # Only run the package if it's exactly the one the gateway made
    if ((Get-FileHash (Join-Path $tmp 'agent.zip') -Algorithm SHA256).Hash -ne '${pkg.zipSha256}') {
      Write-Host 'The download failed its SHA-256 check. Nothing was installed.' -ForegroundColor Red
      return
    }
    Expand-Archive -Path (Join-Path $tmp 'agent.zip') -DestinationPath $tmp
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $tmp 'agent\\install\\windows\\install.ps1') \`
      ${args.join(" ")}
    if ($LASTEXITCODE -ne 0) { Write-Host "The install didn't finish (see above)." -ForegroundColor Red }
  } catch {
    Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
`;
}

const SCRIPTS = { linux: linuxScript, windows: windowsScript, synology: synologyScript };
// The setup program's name carries the short link: BackupAgentSetup_K7Q2MX_192.168.1.25_8080.exe
// (an "s" after the port = https). An address that can't go in a file name (IPv6) gets
// BackupAgentSetup_K7Q2MX.exe, and the program asks for the link.
export function setupFileName(gatewayUrl, short) {
  try {
    const u = new URL(gatewayUrl);
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    if (/^[A-Za-z0-9.-]{1,200}$/.test(u.hostname)) return `BackupAgentSetup_${short}_${u.hostname}_${port}${u.protocol === "https:" ? "s" : ""}.exe`;
  } catch {
    // fall through
  }
  return `BackupAgentSetup_${short}.exe`;
}

export function createInstalls({ config, store, agentPackage, windowsSetup, updateKey = null }) {
  const links = new Map(); // token -> { code, clientName, expiresAt, options, short }
  const shorts = new Map(); // short code -> token

  function prune() {
    const now = Date.now();
    for (const [token, link] of links) {
      if (link.expiresAt.getTime() <= now) forget(token);
    }
  }

  function forget(token) {
    const link = links.get(token);
    if (link) shorts.delete(link.short);
    links.delete(token);
  }

  function live(token) {
    prune();
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? links.get(token) : undefined;
  }

  // The token behind a short code (any case), if it's still live
  function tokenOf(short) {
    prune();
    const code = String(short ?? "").toUpperCase();
    return SHORT_RE.test(code) ? shorts.get(code) : undefined;
  }

  const SCRIPT_FILES = { linux: "linux.sh", windows: "windows.ps1", synology: "synology.sh" };
  const scriptUrl = (base, token, platform) => `${base}/install/${token}/${SCRIPT_FILES[platform]}`;
  const expiresText = (d) => d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  function scriptFor(token, link, ip) {
    log.info(`Install script (${link.options.platform}) for "${link.clientName}" downloaded by ${ip}`);
    store.audit("device", "install-link.used", { clientName: link.clientName, platform: link.options.platform }, ip);
    return SCRIPTS[link.options.platform]({
      gatewayUrl: agentApiUrl(config).url,
      token,
      pkg: agentPackage,
      code: link.code,
      clientName: link.clientName,
      expiresAt: link.expiresAt,
      options: link.options,
      updateKeyB64: updateKey?.publicKeyB64 ?? null,
    });
  }

  return {
    available: Boolean(agentPackage),
    windowsSetupAvailable: Boolean(windowsSetup),

    // Called by the admin API right after it made the enrollment code
    create({ code, clientName, expiresAt, options }) {
      if (!agentPackage) throw new InstallError("The agent package isn't available on this gateway (agent folder not found).");
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      let short;
      do short = newShortCode();
      while (shorts.has(short));
      links.set(token, { code, clientName, expiresAt, options, short });
      shorts.set(short, token);
      const { url, localOnly } = agentApiUrl(config);
      const shortUrl = `${url}/i/${short}`;
      // Only this computer can reach the gateway: say how to open it up, with this computer's addresses
      const network = localOnly ? { port: config.port, addresses: lanAddresses() } : null;
      const common = { short, shortUrl, gatewayUrl: url, localOnly, network };
      if (options.platform === "windows") {
        const ps = `irm ${shortUrl}/win | iex`;
        return {
          platform: "windows",
          ...common,
          commands: [
            { id: "powershell", label: "PowerShell (as Administrator)", command: ps },
            { id: "cmd", label: "Command Prompt (as Administrator)", command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"` },
          ],
          setupUrl: windowsSetup ? `${shortUrl}/setup.exe` : null,
          setupName: windowsSetup ? setupFileName(url, short) : null,
        };
      }
      return {
        platform: options.platform,
        ...common,
        commands: [{ id: "bash", label: options.platform === "synology" ? "SSH" : "Terminal", command: `(curl -fsSL ${shortUrl}/sh || wget -qO- ${shortUrl}/sh) | sudo bash` }],
      };
    },

    // GET /install/<token>/linux.sh or windows.ps1 on the agent API
    script(token, platform, ip) {
      const link = live(token);
      if (!link || link.options.platform !== platform) return null;
      return scriptFor(token, link, ip);
    },

    // The short link's details, for its page: null if it's dead
    shortLink(short) {
      const token = tokenOf(short);
      const link = token && links.get(token);
      if (!link) return null;
      const { url } = agentApiUrl(config);
      return {
        short: link.short,
        url: `${url}/i/${link.short}`,
        platform: link.options.platform,
        upgrade: Boolean(link.options.upgrade),
        clientName: cleanName(link.clientName),
        expires: expiresText(link.expiresAt),
        setupName: link.options.platform === "windows" && windowsSetup ? setupFileName(url, link.short) : null,
      };
    },

    // GET /i/<short>/win or /sh: the script for that link (kind: "windows" or "unix")
    shortScript(short, kind, ip) {
      const token = tokenOf(short);
      const link = token && links.get(token);
      if (!link) return null;
      const isWindows = link.options.platform === "windows";
      if ((kind === "windows") !== isWindows) return { wrong: true, platform: link.options.platform };
      return { script: scriptFor(token, link, ip) };
    },

    // GET /i/<short>/setup.json: what the setup program needs (it checks the package against sha256)
    setupJson(short, ip) {
      const token = tokenOf(short);
      const link = token && links.get(token);
      if (!link || link.options.platform !== "windows") return null;
      log.info(`Setup program for "${link.clientName}" started by ${ip}`);
      store.audit("device", "install-link.used", { clientName: link.clientName, platform: "windows", via: "setup program" }, ip);
      const gatewayUrl = agentApiUrl(config).url;
      return {
        client: cleanName(link.clientName),
        expires: expiresText(link.expiresAt),
        zip: `/install/${token}/agent.zip`,
        sha256: agentPackage.zipSha256,
        args: installerOptions(
          { code: link.code, options: link.options, gatewayUrl, updateKeyB64: updateKey?.publicKeyB64 ?? null },
          true
        ).flatMap(([name, value]) => (value === null ? [name] : [name, value])),
      };
    },

    // GET /i/<short>/setup.exe: the setup program (the same file for everyone) and the name it's saved as
    setupExe(short) {
      const token = tokenOf(short);
      const link = token && links.get(token);
      if (!link || link.options.platform !== "windows" || !windowsSetup) return null;
      return { file: windowsSetup, name: setupFileName(agentApiUrl(config).url, link.short) };
    },

    // The device enrolled with the code: the link is used up
    codeUsed(codeHash) {
      for (const [token, link] of links) if (link.code && hashCode(link.code) === codeHash) forget(token);
    },

    // GET /install/<token>/agent.tar.gz or agent.zip
    package(token, format) {
      if (!live(token)) return null;
      return format === "zip" ? agentPackage.zip : agentPackage.tarGz;
    },
  };
}
