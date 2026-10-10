// Keeps the agent connected to the gateway:
//   1. enrolls once with a one-time code
//   2. swaps encryption public keys with the gateway (and pins the gateway's key)
//   3. sends a heartbeat every 30 seconds, and picks up any jobs (like restores) waiting for it
//   4. keeps a "live link" open: one request the gateway answers the moment there's work
//      (a restore, a folder change, a folder-browse request), so nothing waits for the heartbeat.
//      It's still an outgoing connection, so no ports are opened on this device.
// If the gateway or internet is down, the agent keeps working locally and retries.

import crypto from "node:crypto";
import { loadOrCreateKeys, loadIdentity, saveIdentity } from "./identity.js";
import { createGatewayClient } from "./gateway-client.js";
import { deriveKeys, open } from "./crypto-box.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 30_000;
const LIVE_RETRY_MS = 10_000;

export async function connectToGateway(config, getStatus) {
  const client = createGatewayClient(config.gatewayUrl);
  const keys = loadOrCreateKeys(config.dataDir);
  let identity = loadIdentity(config.dataDir);

  if (identity && identity.gatewayUrl !== config.gatewayUrl) {
    log.warn(`This agent was enrolled with ${identity.gatewayUrl}, but AGENT_GATEWAY_URL is now ${config.gatewayUrl}`);
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
  let stopped = false;

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
      if (online !== true) log.info("Connected to gateway");
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
    } catch (err) {
      if (err.security) {
        log.error(err.message);
      } else if (err.status === 401) {
        log.error("Gateway rejected this device (revoked, or clock is more than 5 minutes off).");
      } else if (err.status) {
        log.error(err.message);
      } else if (online !== false) {
        log.warn(`Gateway unreachable (${err.cause?.code || err.message}). Working offline, will keep retrying.`);
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
    heartbeatNow: heartbeat,
    startLiveLink: () => liveLink(),
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}