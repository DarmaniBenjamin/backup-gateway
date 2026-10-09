// Verifies that every request really comes from an enrolled agent.
//
// Each agent has its own Ed25519 key pair. The private key never leaves the agent;
// the gateway only stores the public key. Every request is signed over:
//   METHOD \n PATH \n TIMESTAMP \n NONCE \n SHA256(BODY)
// so it can't be forged, changed in transit, or replayed later.

import crypto from "node:crypto";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // requests older/newer than 5 minutes are rejected
const seenNonces = new Map();             // nonce -> expiry time (replay protection)

setInterval(() => {
  const now = Date.now();
  for (const [nonce, expires] of seenNonces) if (expires < now) seenNonces.delete(nonce);
}, 60_000).unref();

export function signedPayload(method, path, timestamp, nonce, body) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

export class AuthError extends Error {}

/** Returns the device record if the request is valid, otherwise throws AuthError. */
export function verifyRequest(req, body, db) {
  const deviceId = req.headers["x-device-id"];
  const timestamp = req.headers["x-timestamp"];
  const nonce = req.headers["x-nonce"];
  const signature = req.headers["x-signature"];

  if (!deviceId || !timestamp || !nonce || !signature) throw new AuthError("Missing auth headers");

  const age = Math.abs(Date.now() - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_CLOCK_SKEW_MS) throw new AuthError("Request expired or clock wrong");

  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) throw new AuthError("Bad nonce");
  if (seenNonces.has(nonce)) throw new AuthError("Replayed request");

  const device = db.getDevice(deviceId);
  if (!device) throw new AuthError("Unknown device");
  if (device.status !== "active") throw new AuthError("Device revoked");

  const payload = signedPayload(req.method, req.url, timestamp, nonce, body);
  let valid = false;
  try {
    valid = crypto.verify(null, Buffer.from(payload), device.public_key, Buffer.from(signature, "base64"));
  } catch {
    valid = false;
  }
  if (!valid) throw new AuthError("Bad signature");

  seenNonces.set(nonce, Date.now() + 2 * MAX_CLOCK_SKEW_MS);
  return device;
}