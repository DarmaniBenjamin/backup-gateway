// Self-update, the agent's half. When the gateway offers a newer agent (on a heartbeat, encrypted
// for this device), this downloads the package, checks it against the manifest the gateway
// signed, and hands it to the updater: a separate job the installer set up that runs as
// root/SYSTEM (install/updater/update.mjs). The updater checks everything again with its own copy
// of the gateway's update key, swaps in the new version, and puts the old one back if the new one
// doesn't come up.
//
// Files in <data>/update/:
//   package.tar.gz|zip, manifest.json, manifest.sig   the update, waiting to be installed
//   request.json    "please install this" (the updater is started when it appears)
//   result.json     how the last update went (written by the updater)
//   alive.json      written by the agent once it's connected: the updater waits for this
//
// The same updater also uninstalls the agent when the web UI asks (request.json with action
// "uninstall" and the gateway's signed order). That's refused while the folder lock is on.
//
// AGENT_UPDATER (set by the installer) says how to reach the updater: "systemd" (a path unit
// watches request.json) or "windows-task" (an on-demand scheduled task).

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { log } from "./logger.js";

export function newerVersion(a, b) {
  const p = (v) => String(v ?? "0").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

const keyFromB64 = (b64) => crypto.createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

export function createUpdater({ dataDir, version, mechanism = process.env.AGENT_UPDATER?.trim() || null }) {
  const dir = path.join(dataDir, "update");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const capable = mechanism === "systemd" || mechanism === "windows-task";
  const state = { state: "idle", version: null, error: null, at: null };
  let busy = false;
  let removal = null; // { state: uninstalling | refused | failed, error, at }

  const file = (name) => path.join(dir, name);
  const readJson = (name) => {
    try {
      return JSON.parse(fs.readFileSync(file(name), "utf8"));
    } catch {
      return null;
    }
  };
  // Written under a temporary name, then renamed: the updater never sees half a file
  function writeAtomic(name, data) {
    const tmp = file(`${name}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file(name));
  }
  const set = (s, extra = {}) => Object.assign(state, { state: s, error: null, at: new Date().toISOString() }, extra);

  // How the last update went (the updater left result.json)
  const last = readJson("result.json");
  if (last?.action === "uninstall") {
    if (!last.ok) removal = { order: last.order ?? null, state: "failed", error: last.error ?? "The uninstall failed.", at: last.at };
  } else if (last?.version) {
    if (last.ok && last.version === version) set("done", { version });
    else if (!last.ok) set("failed", { version: last.version, error: last.error ?? "The update failed." });
  }

  function trigger() {
    if (mechanism === "windows-task") {
      return new Promise((resolve, reject) =>
        execFile("schtasks.exe", ["/run", "/tn", "BackupAgentUpdate"], { windowsHide: true }, (err, _out, stderr) =>
          err ? reject(new Error(`Couldn't start the updater: ${(stderr || err.message).trim()}`)) : resolve(),
        ),
      );
    }
    // systemd: backup-agent-update.path starts the updater as soon as request.json appears
    return Promise.resolve();
  }

  // The gateway's signed message is checked here, and again by the updater with its own key
  function checkSigned(offer, identity, saveIdentity) {
    if (!identity.gatewayUpdateKey) {
      identity.gatewayUpdateKey = offer.publicKey;
      saveIdentity(identity);
    } else if (identity.gatewayUpdateKey !== offer.publicKey) {
      throw new Error("The gateway's update key changed. Refused (reinstall the agent if the gateway was rebuilt).");
    }
    const text = offer.manifest ?? offer.order;
    if (!crypto.verify(null, Buffer.from(text), keyFromB64(identity.gatewayUpdateKey), Buffer.from(offer.signature, "base64"))) {
      throw new Error("The gateway's signature doesn't match. Refused.");
    }
  }

  return {
    capable,
    status: () => ({ capable, mechanism, ...state }),
    uninstallStatus: () => removal,

    // Uninstall order from the gateway (already decrypted): { order, signature, publicKey }
    async uninstall(offer, { identity, saveIdentity, locked, heartbeatNow }) {
      if (removal?.state === "uninstalling") return;
      try {
        if (!capable) throw new Error("This agent has no updater, so it can't uninstall itself. Uninstall it on the device.");
        checkSigned(offer, identity, saveIdentity);
        const order = JSON.parse(offer.order);
        if (order.format !== "backup-agent-uninstall" || order.deviceId !== identity.deviceId) throw new Error("The uninstall order isn't for this device.");
        if (locked) {
          const first = removal?.state !== "refused" || removal?.order !== order.id;
          removal = { order: order.id, state: "refused", error: "The folder lock is on. Unlock it with its key and it uninstalls straight after.", at: new Date().toISOString() };
          if (first) {
            log.warn("Asked to uninstall, but the folder lock is on: unlock it with its key first");
            setTimeout(() => heartbeatNow?.().catch(() => {}), 0); // tell the gateway now
          }
          return;
        }
        removal = { order: order.id, state: "uninstalling", error: null, at: new Date().toISOString() };
        log.warn(`Uninstalling this agent, as asked by ${order.by ?? "the gateway"}. The backed-up files on this device aren't touched.`);
        // Tell the gateway first: once the updater starts, this agent stops
        await new Promise((r) => setTimeout(r, 0));
        await heartbeatNow?.().catch(() => {});
        fs.rmSync(file("result.json"), { force: true });
        writeAtomic("request.json", JSON.stringify({ action: "uninstall", order: offer.order, signature: offer.signature, at: new Date().toISOString() }));
        await trigger();
        // Still here after 5 minutes: the updater failed (it says why in result.json)
        setTimeout(() => {
          const result = readJson("result.json");
          if (result?.action === "uninstall" && !result.ok) removal = { order: removal.order, state: "failed", error: result.error ?? "The uninstall failed.", at: new Date().toISOString() };
          else if (!result) removal = { order: removal.order, state: "failed", error: "The updater didn't start. Is backup-agent-update installed?", at: new Date().toISOString() };
        }, 5 * 60_000).unref();
      } catch (err) {
        log.warn(`Uninstall failed: ${err.message}`);
        let id = null;
        try {
          id = JSON.parse(offer.order).id ?? null;
        } catch {
          id = null;
        }
        removal = { order: id, state: "failed", error: err.message, at: new Date().toISOString() };
      }
    },

    // Called once the agent is connected: tells a waiting updater that this version came up fine
    alive() {
      try {
        writeAtomic("alive.json", JSON.stringify({ version, pid: process.pid, at: new Date().toISOString() }));
      } catch (err) {
        log.warn(`Couldn't write update/alive.json: ${err.message}`);
      }
    },

    // An offer from the gateway (already decrypted): { version, manifest, signature, publicKey }
    async handle(offer, { client, auth, identity, saveIdentity }) {
      if (!capable || busy || !offer?.version || !newerVersion(offer.version, version)) return;
      if (state.state === "failed" && state.version === offer.version && fs.existsSync(file("request.json"))) return;
      busy = true;
      set("downloading", { version: offer.version });
      try {
        // The update key is pinned the first time it's seen; a different one is refused
        checkSigned(offer, identity, saveIdentity);
        const manifest = JSON.parse(offer.manifest);
        if (manifest.format !== "backup-agent-update" || manifest.version !== offer.version) throw new Error("The update's manifest doesn't match the offer.");
        const kind = process.platform === "win32" ? "zip" : "tar";
        const pkg = await client.signedGet(`/api/update/agent.${kind === "zip" ? "zip" : "tar.gz"}`, auth);
        if (!Buffer.isBuffer(pkg)) throw new Error("The gateway didn't send the package.");
        const sha = crypto.createHash("sha256").update(pkg).digest("hex");
        if (pkg.length !== manifest[kind].size || sha !== manifest[kind].sha256) throw new Error("The downloaded package doesn't match its signed manifest.");

        for (const old of fs.readdirSync(dir)) if (old.startsWith("package.")) fs.rmSync(file(old), { force: true });
        fs.rmSync(file("result.json"), { force: true });
        writeAtomic(kind === "zip" ? "package.zip" : "package.tar.gz", pkg);
        writeAtomic("manifest.json", offer.manifest);
        writeAtomic("manifest.sig", offer.signature);
        set("staged", { version: offer.version });
        log.info(`Agent ${offer.version} downloaded and checked; handing it to the updater`);
        writeAtomic("request.json", JSON.stringify({ version: offer.version, package: kind === "zip" ? "package.zip" : "package.tar.gz", from: version, at: new Date().toISOString() }));
        await trigger();
        set("applying", { version: offer.version });
        // The updater stops this agent and starts the new one; if that doesn't happen, say so
        setTimeout(() => {
          const result = readJson("result.json");
          if (state.state === "applying" && result && !result.ok) set("failed", { version: offer.version, error: result.error ?? "The update failed." });
          else if (state.state === "applying" && !result) set("failed", { version: offer.version, error: "The updater didn't start. Is backup-agent-update installed?" });
          busy = false;
        }, 5 * 60_000).unref();
      } catch (err) {
        log.warn(`Agent update to ${offer.version} failed: ${err.message}`);
        set("failed", { version: offer.version, error: err.message });
        busy = false;
      }
    },
  };
}
