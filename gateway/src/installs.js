// One-line installs: "Add device" in the web UI creates an install link that carries everything
// the new device needs (gateway address, enrollment code, allowed folders, name). On the device
// you paste one command (or run the setup .exe on Windows); it downloads a small script from the
// link, which downloads the agent package, checks its SHA-256 and runs the installer with those
// settings.
//
//   Linux:    (curl … || wget …) | sudo bash              -> linux.sh  -> agent.tar.gz
//   Synology: the same, over SSH on the NAS                 -> synology.sh -> agent.tar.gz
//   Windows:  irm … | iex  (PowerShell or Command Prompt) -> windows.ps1 -> agent.zip
//             or BackupAgentSetup.exe (the same, double-clickable; the link is added to its end)
//
// Links live in memory only — the enrollment code inside them is never written to disk — and
// stop working when their device enrolls, when their code expires, or when the gateway restarts.

import crypto from "node:crypto";
import os from "node:os";
import { hashCode } from "./codes.js";
import { log } from "./logger.js";

export const PLATFORMS = ["linux", "windows", "synology"];

export class InstallError extends Error {}

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

// The installer's options. An upgrade (an enrolled device getting the self-updater) passes only the
// update key: the installer keeps everything else as it is. The key is base64 (safe in quotes).
function installerArgs({ code, options, gatewayUrl, updateKeyB64 }, win = false) {
  const o = (name) => (win ? `-${name[0].toUpperCase()}${name.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase())}` : `--${name}`);
  const args = [];
  if (!options.upgrade) {
    args.push(`${o("gateway")} ${q(gatewayUrl)}`, `${o("code")} ${q(code)}`);
    args.push(options.fullAccess ? (win ? "-FullAccess" : "--full-access") : `${o("allowed")} ${q(options.allowed)}`);
    if (options.name) args.push(`${o("name")} ${q(options.name)}`);
    if (options.watch) args.push(`${o("watch")} ${q(options.watch)}`);
  }
  if (updateKeyB64) args.push(`${o("update-key")} ${q(updateKeyB64)}`);
  return args;
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
const SETUP_MAGIC = Buffer.from("BGSETUP1");

export function createInstalls({ config, store, agentPackage, windowsSetup, updateKey = null }) {
  const links = new Map(); // token -> { code, clientName, expiresAt, options }

  function prune() {
    const now = Date.now();
    for (const [token, link] of links) if (link.expiresAt.getTime() <= now) links.delete(token);
  }

  function live(token) {
    prune();
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? links.get(token) : undefined;
  }

  const SCRIPT_FILES = { linux: "linux.sh", windows: "windows.ps1", synology: "synology.sh" };
  const scriptUrl = (base, token, platform) => `${base}/install/${token}/${SCRIPT_FILES[platform]}`;

  return {
    available: Boolean(agentPackage),
    windowsSetupAvailable: Boolean(windowsSetup),

    // Called by the admin API right after it made the enrollment code
    create({ code, clientName, expiresAt, options }) {
      if (!agentPackage) throw new InstallError("The agent package isn't available on this gateway (agent folder not found).");
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      links.set(token, { code, clientName, expiresAt, options });
      const { url, localOnly } = agentApiUrl(config);
      const script = scriptUrl(url, token, options.platform);
      if (options.platform === "windows") {
        const ps = `irm '${script}' | iex`;
        return {
          platform: "windows",
          commands: [
            { id: "powershell", label: "PowerShell (as Administrator)", command: ps },
            { id: "cmd", label: "Command Prompt (as Administrator)", command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "${ps}"` },
          ],
          setupUrl: windowsSetup ? `${url}/install/${token}/BackupAgentSetup.exe` : null,
          gatewayUrl: url,
          localOnly,
        };
      }
      return {
        platform: options.platform,
        commands: [{ id: "bash", label: options.platform === "synology" ? "SSH" : "Terminal", command: `(curl -fsSL '${script}' || wget -qO- '${script}') | sudo bash` }],
        gatewayUrl: url,
        localOnly,
      };
    },

    // GET /install/<token>/linux.sh or windows.ps1 on the agent API
    script(token, platform, ip) {
      const link = live(token);
      if (!link || link.options.platform !== platform) return null;
      log.info(`Install script (${platform}) for "${link.clientName}" downloaded by ${ip}`);
      store.audit("device", "install-link.used", { clientName: link.clientName, platform }, ip);
      return SCRIPTS[platform]({
        gatewayUrl: agentApiUrl(config).url,
        token,
        pkg: agentPackage,
        code: link.code,
        clientName: link.clientName,
        expiresAt: link.expiresAt,
        options: link.options,
        updateKeyB64: updateKey?.publicKeyB64 ?? null,
      });
    },

    // GET /install/<token>/BackupAgentSetup.exe: the generic setup program with this link added to its end
    setupExe(token) {
      const link = live(token);
      if (!link || link.options.platform !== "windows" || !windowsSetup) return null;
      const info = Buffer.from(
        JSON.stringify({
          script: scriptUrl(agentApiUrl(config).url, token, "windows"),
          client: cleanName(link.clientName),
          expires: link.expiresAt.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
        })
      );
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(BigInt(info.length));
      return Buffer.concat([windowsSetup, info, len, SETUP_MAGIC]);
    },

    // The device enrolled with the code: the link is used up
    codeUsed(codeHash) {
      for (const [token, link] of links) if (link.code && hashCode(link.code) === codeHash) links.delete(token);
    },

    // GET /install/<token>/agent.tar.gz or agent.zip
    package(token, format) {
      if (!live(token)) return null;
      return format === "zip" ? agentPackage.zip : agentPackage.tarGz;
    },
  };
}
