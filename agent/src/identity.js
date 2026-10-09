// The agent's identity, all stored in its data folder with owner-only permissions:
//   device-key.pem = Ed25519 private key, signs every request (proves who we are)
//   kx-key.pem     = X25519 private key, agrees on encryption keys with the gateway
//   identity.json  = device ID from the gateway, plus the gateway's pinned public key
// Private keys are created on this device and NEVER sent anywhere.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function loadOrCreateKey(dataDir, fileName, type) {
  const keyPath = path.join(dataDir, fileName);
  let privateKey;
  if (fs.existsSync(keyPath)) {
    privateKey = crypto.createPrivateKey(fs.readFileSync(keyPath));
  } else {
    ({ privateKey } = crypto.generateKeyPairSync(type));
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return { privateKey, publicKeyPem: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }) };
}

export function loadOrCreateKeys(dataDir) {
  return {
    signing: loadOrCreateKey(dataDir, "device-key.pem", "ed25519"),
    exchange: loadOrCreateKey(dataDir, "kx-key.pem", "x25519"),
  };
}

const identityPath = (dataDir) => path.join(dataDir, "identity.json");

export function loadIdentity(dataDir) {
  const file = identityPath(dataDir);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function saveIdentity(dataDir, identity) {
  fs.writeFileSync(identityPath(dataDir), JSON.stringify(identity, null, 2), { mode: 0o600 });
}