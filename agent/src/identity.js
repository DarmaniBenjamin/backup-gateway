// The agent's identity: its own Ed25519 key pair plus the device ID the gateway gave it.
// The private key is created on this device, saved with owner-only permissions,
// and NEVER sent anywhere. The gateway only ever sees the public key.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function loadOrCreateKeys(dataDir) {
  const privatePath = path.join(dataDir, "device-key.pem");

  if (fs.existsSync(privatePath)) {
    const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath));
    return { privateKey, publicKeyPem: crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }) };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  return { privateKey, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) };
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