// The gateway's own X25519 key pair, used to agree on encryption keys with each agent.
// The private key stays on the gateway, saved with owner-only permissions.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { deriveKeys } from "./crypto-box.js";

export function loadOrCreateGatewayKeys(dataDir) {
  const keyPath = path.join(dataDir, "gateway-kx-key.pem");
  let privateKey;
  if (fs.existsSync(keyPath)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } else {
    ({ privateKey } = crypto.generateKeyPairSync("x25519"));
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" });

  const cache = new Map(); // deviceId -> { encKey, idKey }
  return {
    publicKeyPem,
    // Keys for talking to one device (null if that device hasn't done the key exchange yet)
    forDevice(device) {
      if (!device.kx_public_key) return null;
      if (!cache.has(device.id)) {
        cache.set(device.id, deriveKeys(privateKey, crypto.createPublicKey(device.kx_public_key), device.id));
      }
      return cache.get(device.id);
    },
  };
}