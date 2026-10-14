// Keeps the agent connected to the gateway:
//   1. enrolls once with a one-time code
//   2. swaps encryption public keys with the gateway (and pins the gateway's key)
//   3. sends a heartbeat every 30 seconds, and picks up any jobs (like restores) waiting for it
//   4. keeps a "live link" open: one request the gateway answers the moment there's work
//      (a restore, a folder change, a folder-browse request), so nothing waits for the heartbeat.
//      It's still an outgoing connection, so no ports are opened on this device.
// If the gateway or internet is down, the agent keeps working locally and retries.
//
// The gateway's address can change: it gets a domain with its certificate, or its IP address
// changes. With every heartbeat the gateway sends the list of addresses it can be reached at
// (encrypted for this device, so nobody in between can change it). The agent moves to the domain as
// soon as it's there, and if the address it uses stops answering, it tries the others. It only ever
// moves to an address that answers with the gateway's own pinned key.

import crypto from "node:crypto";
import { loadOrCreateKeys, loadIdentity, saveIdentity } from "./identity.js";
import { createGatewayClient } from "./gateway-client.js";
import { deriveKeys, open } from "./crypto-box.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 30_000;
const LIVE_RETRY_MS = 10_000;
const FAILS_BEFORE_SWITCH = 3; // about a minute and a half without the gateway
const RETRY_ADDRESS_MS = 10 * 60_000; // don't try the same address again sooner than this

// An address from the gateway's list: http(s) only, no user name or password in it
function cleanUrl(value) {
  try {
    const u = new URL(String(value));
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export async function connectToGateway(config, getStatus) {
  const keys = loadOrCreateKeys(config.dataDir);
  let identity = loadIdentity(config.dataDir);
  // The address it moved to last time (the gateway's domain, say), else the one it was installed with
  const client = createGatewayClient(cleanUrl(identity?.currentUrl) ?? config.gatewayUrl);
  if (identity?.currentUrl && identity.currentUrl !== config.gatewayUrl) {
    log.info(`Using the gateway at ${identity.currentUrl} (installed with ${config.gatewayUrl})`);
  }

  if (!identity) {
    if (!config.enrollCode) {
      log.error("This device is not enrolled. Create a code on the gateway (npm run new-code) and set AGENT_ENROLL_CODE.");
      return null;
    }
    log.info(`Enrolling with gateway ${config.gatewayUrl}...`);
    const result = await client.enroll({
      code: config.enrollCode,
      deviceName: config.deviceName,
      publicKeyPem: keys.signing.publicKeyPem,
    });
    identity = {
      deviceId: result.deviceId,
      clientName: result.clientName,
      gatewayUrl: config.gatewayUrl,
      enrolledAt: new Date().toISOString(),
    };
    saveIdentity(config.dataDir, identity);
    log.info(`Enrolled as ${identity.deviceId} for client "${identity.clientName}". You can now remove AGENT_ENROLL_CODE from .env`);
  } else {
    log.info(`Enrolled as ${identity.deviceId} for client "${identity.clientName}"`);
  }

  const auth = { deviceId: identity.deviceId, privateKey: keys.signing.privateKey };
  let cryptoKeys = null;
  let online = null;
  let commandHandler = null;
  let foldersHandler = null;
  let browseHandler = null;
  let updateHandler = null;
  let uninstallHandler = null;
  let onlineHandler = null;
  let stopped = false;
  let failures = 0;
  const tried = new Map(); // address -> when it was last tried
  let moving = false;

  // Does this address reach OUR gateway? It must answer this device's signed request with the
  // gateway's key pinned at enrollment: an address that leads anywhere else can't.
  async function reachesGateway(url) {
    if (!identity.gatewayKxPublicKey) return false;
    try {
      const probe = createGatewayClient(url);
      const reply = await probe.signedPost("/api/key-exchange", { kxPublicKey: keys.exchange.publicKeyPem }, auth);
      return reply?.gatewayKxPublicKey === identity.gatewayKxPublicKey;
    } catch {
      return false;
    }
  }

  async function moveTo(url, why) {
    if (moving || url === client.baseUrl()) return false;
    const last = tried.get(url) ?? 0;
    if (Date.now() - last < RETRY_ADDRESS_MS) return false;
    moving = true;
    tried.set(url, Date.now());
    try {
      if (!(await reachesGateway(url))) return false;
      log.info(`Moving to the gateway at ${url} (${why})`);
      client.setBaseUrl(url);
      identity.currentUrl = url;
      saveIdentity(config.dataDir, identity);
      failures = 0;
      return true;
    } finally {
      moving = false;
    }
  }

  // The gateway's list of addresses: move to the domain when it's there, or off an address
  // that's no longer on the list
  async function useAddresses(list) {
    identity.gatewayUrls = list;
    saveIdentity(config.dataDir, identity);
    const current = client.baseUrl();
    const best = list[0];
    const better = best.startsWith("https://") && !current.startsWith("https://");
    if (best !== current && (better || !list.includes(current))) await moveTo(best, better ? "its secure address" : "its address changed");
  }

  // The address in use stopped answering: try the others the gateway gave, then the original one
  async function tryOthers() {
    const others = [...(identity.gatewayUrls ?? []), config.gatewayUrl].map(cleanUrl).filter(Boolean);
    for (const url of [...new Set(others)]) {
      if (await moveTo(url, `${client.baseUrl()} isn't answering`)) return;
    }
  }

  // Swap X25519 public keys with the gateway once, then derive the encryption keys.
  // The gateway's key is pinned: if it ever changes, the agent refuses to send data.
  async function ensureKeys() {
    if (cryptoKeys) return cryptoKeys;
    const result = await client.signedPost("/api/key-exchange", { kxPublicKey: keys.exchange.publicKeyPem }, auth);
    const gatewayKey = result.gatewayKxPublicKey;

    if (!identity.gatewayKxPublicKey) {
      identity.gatewayKxPublicKey = gatewayKey;
      saveIdentity(config.dataDir, identity);
      log.info("Encryption keys exchanged with gateway");
    } else if (identity.gatewayKxPublicKey !== gatewayKey) {
      const err = new Error("SECURITY ALERT: gateway encryption key changed! Refusing to send data (possible impersonation).");
      err.security = true;
      throw err;
    }

    cryptoKeys = deriveKeys(keys.exchange.privateKey, crypto.createPublicKey(identity.gatewayKxPublicKey), identity.deviceId);
    return cryptoKeys;
  }

  async function heartbeat() {
    try {
      const reply = await client.signedPost("/api/heartbeat", getStatus(), auth);
      const k = await ensureKeys();
      if (online !== true) {
        log.info("Connected to gateway");
        onlineHandler?.();
      }
      online = true;

      // Jobs arrive encrypted for this device only. Anything that doesn't decrypt is ignored.
      for (const item of reply.commands || []) {
        try {
          const aad = `command:${identity.deviceId}:${item.id}`;
          const command = JSON.parse(open(k.encKey, Buffer.from(item.sealed, "base64"), aad).toString("utf8"));
          if (command.id !== item.id) throw new Error("id mismatch");
          commandHandler?.(command);
        } catch {
          log.warn(`Ignored job #${item.id}: failed its integrity check`);
        }
      }

      // Folder-browse requests from the web UI, encrypted the same way
      for (const item of reply.browse || []) {
        try {
          const aad = `browse:${identity.deviceId}:${item.id}`;
          const request = JSON.parse(open(k.encKey, Buffer.from(item.sealed, "base64"), aad).toString("utf8"));
          if (request.id !== item.id) throw new Error("id mismatch");
          browseHandler?.(request);
        } catch {
          log.warn("Ignored a folder-browse request: failed its integrity check");
        }
      }

      if (Number.isInteger(reply.foldersVersion)) foldersHandler?.(reply.foldersVersion);
      failures = 0;

      // The addresses this gateway can be reached at, best first, encrypted for this device
      if (reply.addresses) {
        try {
          const list = JSON.parse(open(k.encKey, Buffer.from(reply.addresses, "base64"), `addresses:${identity.deviceId}`).toString("utf8"));
          const clean = (Array.isArray(list) ? list : []).map(cleanUrl).filter(Boolean).slice(0, 8);
          if (clean.length) useAddresses(clean).catch(() => {});
        } catch {
          log.warn("Ignored the gateway's address list: failed its integrity check");
        }
      }

      // A newer agent offered by the gateway (see updater.js), encrypted for this device
      if (reply.update) {
        try {
          const offer = JSON.parse(open(k.encKey, Buffer.from(reply.update, "base64"), `update:${identity.deviceId}`).toString("utf8"));
          updateHandler?.(offer, { client, auth, identity, saveIdentity: (id) => saveIdentity(config.dataDir, id) });
        } catch {
          log.warn("Ignored an update offer: failed its integrity check");
        }
      }

      // Uninstall, asked for in the web UI: signed by the gateway, encrypted for this device
      if (reply.uninstall) {
        try {
          const order = JSON.parse(open(k.encKey, Buffer.from(reply.uninstall, "base64"), `uninstall:${identity.deviceId}`).toString("utf8"));
          uninstallHandler?.(order, { identity, saveIdentity: (id) => saveIdentity(config.dataDir, id) });
        } catch {
          log.warn("Ignored an uninstall order: failed its integrity check");
        }
      }
    } catch (err) {
      if (err.security) {
        log.error(err.message);
      } else if (err.status === 401) {
        log.error("Gateway rejected this device (revoked, or clock is more than 5 minutes off).");
      } else if (err.status) {
        log.error(err.message);
      } else {
        if (online !== false) log.warn(`Gateway unreachable (${err.cause?.code || err.message}). Working offline, will keep retrying.`);
        failures += 1;
        if (failures >= FAILS_BEFORE_SWITCH) tryOthers().catch(() => {});
      }
      online = false;
    }
  }

  await heartbeat();
  const timer = setInterval(heartbeat, HEARTBEAT_MS);

  // Live link: wait for the gateway to say "there's work", then fetch it with a heartbeat
  async function liveLink() {
    while (!stopped) {
      try {
        const reply = await client.signedGet("/api/wait", auth);
        if (reply.work) await heartbeat();
      } catch (err) {
        if (err.status === 404) {
          log.warn("This gateway doesn't support the live link yet; jobs arrive with the heartbeat instead.");
          return;
        }
        await new Promise((r) => setTimeout(r, LIVE_RETRY_MS));
      }
    }
  }

  return {
    identity,
    auth,
    client,
    ensureKeys,
    isOnline: () => online === true,
    onCommand: (fn) => {
      commandHandler = fn;
    },
    onFoldersVersion: (fn) => {
      foldersHandler = fn;
    },
    onBrowse: (fn) => {
      browseHandler = fn;
    },
    onUpdate: (fn) => {
      updateHandler = fn;
    },
    onUninstall: (fn) => {
      uninstallHandler = fn;
    },
    onOnline: (fn) => {
      onlineHandler = fn;
      if (online === true) fn();
    },
    heartbeatNow: heartbeat,
    startLiveLink: () => liveLink(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}