// Talks to the gateway. Every request after enrollment is signed with the device's private key.
// The agent only ever makes OUTGOING connections — no ports are opened on the client.

import crypto from "node:crypto";

const TIMEOUT_MS = 60_000;

function signedPayload(method, path, timestamp, nonce, body) {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}\n${bodyHash}`;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

export function createGatewayClient(gatewayUrl) {
  // Sends any signed request. body must be a Buffer.
  async function signedRequest(method, path, body, contentType, { deviceId, privateKey }) {
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(18).toString("base64url");
    const signature = crypto
      .sign(null, Buffer.from(signedPayload(method, path, timestamp, nonce, body)), privateKey)
      .toString("base64");

    const res = await fetch(`${gatewayUrl}${path}`, {
      method,
      headers: {
        "Content-Type": contentType,
        "X-Device-Id": deviceId,
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await readJson(res);
    if (!res.ok) {
      const err = new Error(`Gateway returned ${res.status}: ${data.error || "unknown error"}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    // First contact: trade the one-time code for a device ID
    async enroll({ code, deviceName, publicKeyPem }) {
      const res = await fetch(`${gatewayUrl}/api/enroll`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceName, publicKey: publicKeyPem }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(`Enrollment failed (${res.status}): ${data.error || "unknown error"}`);
      return data;
    },

    signedPost: (path, payload, auth) =>
      signedRequest("POST", path, Buffer.from(JSON.stringify(payload)), "application/json", auth),

    signedPostBinary: (path, body, auth) => signedRequest("POST", path, body, "application/octet-stream", auth),

    signedPutBinary: (path, body, auth) => signedRequest("PUT", path, body, "application/octet-stream", auth),
  };
}