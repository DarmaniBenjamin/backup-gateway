// Keeps the agent connected to the gateway: enrolls once, then sends a heartbeat every 30 seconds.
// If the gateway or internet is down, the agent keeps working locally and retries.

import { loadOrCreateKeys, loadIdentity, saveIdentity } from "./identity.js";
import { createGatewayClient } from "./gateway-client.js";
import { log } from "./logger.js";

const HEARTBEAT_MS = 30_000;

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
      publicKeyPem: keys.publicKeyPem,
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

  const auth = { deviceId: identity.deviceId, privateKey: keys.privateKey };
  let online = null;

  async function heartbeat() {
    try {
      await client.signedPost("/api/heartbeat", getStatus(), auth);
      if (online !== true) log.info("Connected to gateway");
      online = true;
    } catch (err) {
      if (err.status === 401) {
        log.error("Gateway rejected this device (revoked, or clock is more than 5 minutes off).");
      } else if (online !== false) {
        log.warn(`Gateway unreachable (${err.cause?.code || err.message}). Working offline, will keep retrying.`);
      }
      online = false;
    }
  }

  await heartbeat();
  const timer = setInterval(heartbeat, HEARTBEAT_MS);
  return { identity, auth, client, stop: () => clearInterval(timer) };
}