// One-line installs: "Add device" in the web UI creates an install link that carries everything
// the new device needs (gateway address, enrollment code, allowed folders, name). On the device
// you paste one command; it downloads a small script from the link, which downloads the agent
// package, checks its SHA-256 and runs the installer with those settings.
//
// Links live in memory only — the enrollment code inside them is never written to disk — and
// stop working when their code expires (or when the gateway restarts: just create a new one).

import crypto from "node:crypto";
import os from "node:os";
import { hashCode } from "./codes.js";
import { log } from "./logger.js";

export const PLATFORMS = ["linux"];

export class InstallError extends Error {}

// Text that ends up inside the install script: no quotes, backslashes, $ or control characters
const SAFE_TEXT = /^[^'"\\$`\u0000-\u001f\u007f]*$/;

function cleanPathList(value) {
  const list = String(value ?? "")
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  if (list.length === 0) throw new InstallError("Enter at least one allowed folder, e.g. /home");
  if (list.length > 20) throw new InstallError("At most 20 allowed folders.");
  for (const p of list) {
    if (!p.startsWith("/")) throw new InstallError(`Allowed folders must be full paths starting with /: ${p}`);
    if (p === "/") throw new InstallError('The whole disk (/) can\'t be allowed. List the folders with data instead, e.g. "/home;/srv".');
    if (p.length > 500 || !SAFE_TEXT.test(p)) throw new InstallError(`This folder name can't be used: ${p}`);
  }
  return list.join(";");
}

export function cleanInstallOptions(body) {
  const platform = String(body.platform ?? "");
  if (!PLATFORMS.includes(platform)) throw new InstallError("This kind of device isn't supported yet.");
  const allowed = cleanPathList(body.allowed);
  const name = String(body.deviceName ?? "").trim();
  if (name.length > 64 || !SAFE_TEXT.test(name)) throw new InstallError("Device name: up to 64 characters, no quotes, \\ or $.");
  const watch = String(body.watch ?? "").trim();
  if (watch) {
    if (!watch.startsWith("/") || watch.length > 500 || !SAFE_TEXT.test(watch)) {
      throw new InstallError("The first folder to back up must be a full path starting with /.");
    }
    if (!allowed.split(";").some((a) => watch === a || watch.startsWith(a.replace(/\/+$/, "") + "/"))) {
      throw new InstallError("The first folder to back up must be inside one of the allowed folders.");
    }
  }
  return { platform, allowed, name, watch };
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

const q = (s) => `'${s}'`; // safe: every value was checked against SAFE_TEXT

function linuxScript({ gatewayUrl, token, sha256, code, clientName, expiresAt, options }) {
  const pkgUrl = `${gatewayUrl}/install/${token}/agent.tar.gz`;
  const args = [`--gateway ${q(gatewayUrl)}`, `--code ${q(code)}`, `--allowed ${q(options.allowed)}`];
  if (options.name) args.push(`--name ${q(options.name)}`);
  if (options.watch) args.push(`--watch ${q(options.watch)}`);
  return `#!/usr/bin/env bash
# Backup agent install for ${clientName.replace(/[^\w .&()-]/g, "")}, made by the backup gateway.
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
  echo "${sha256}  $tmp/agent.tar.gz" | sha256sum -c --quiet - || {
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

export function createInstalls({ config, store, agentPackage }) {
  const links = new Map(); // token -> { code, clientName, expiresAt, options }

  function prune() {
    const now = Date.now();
    for (const [token, link] of links) if (link.expiresAt.getTime() <= now) links.delete(token);
  }

  function live(token) {
    prune();
    return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? links.get(token) : undefined;
  }

  return {
    available: Boolean(agentPackage),

    // Called by the admin API right after it made the enrollment code
    create({ code, clientName, expiresAt, options }) {
      if (!agentPackage) throw new InstallError("The agent package isn't available on this gateway (agent folder not found).");
      prune();
      const token = crypto.randomBytes(32).toString("base64url");
      links.set(token, { code, clientName, expiresAt, options });
      const { url, localOnly } = agentApiUrl(config);
      const scriptUrl = `${url}/install/${token}/${options.platform}.sh`;
      return {
        command: `(curl -fsSL '${scriptUrl}' || wget -qO- '${scriptUrl}') | sudo bash`,
        gatewayUrl: url,
        localOnly,
      };
    },

    // GET /install/<token>/linux.sh on the agent API
    script(token, platform, ip) {
      const link = live(token);
      if (!link || link.options.platform !== platform) return null;
      log.info(`Install script for "${link.clientName}" downloaded by ${ip}`);
      store.audit("device", "install-link.used", { clientName: link.clientName, platform }, ip);
      return linuxScript({
        gatewayUrl: agentApiUrl(config).url,
        token,
        sha256: agentPackage.sha256,
        code: link.code,
        clientName: link.clientName,
        expiresAt: link.expiresAt,
        options: link.options,
      });
    },

    // The device enrolled with the code: the link is used up
    codeUsed(codeHash) {
      for (const [token, link] of links) if (hashCode(link.code) === codeHash) links.delete(token);
    },

    // GET /install/<token>/agent.tar.gz
    package(token) {
      return live(token) ? agentPackage.tarGz : null;
    },
  };
}
