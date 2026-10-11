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
// The gateway's Ed25519 key for signing agent updates. Each device's updater keeps the public half
// (written there by the installer) and only installs an update this key signed, so even someone who
// gets between the gateway and the device, or into the agent's own account, can't push code to it.
export function loadOrCreateUpdateKey(dataDir) {
  const keyPath = path.join(dataDir, "gateway-update-key.pem");
  let privateKey;
  if (fs.existsSync(keyPath)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } else {
    ({ privateKey } = crypto.generateKeyPairSync("ed25519"));
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    // The same public key as one base64 line (safe to pass to an install script)
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    sign: (data) => crypto.sign(null, Buffer.from(data), privateKey).toString("base64"),
  };
}
