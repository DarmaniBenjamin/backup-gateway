// HTTP API the agents talk to.
//   POST /api/enroll     (no login — uses a one-time code)
//   POST /api/heartbeat  (signed by the device's private key)

import http from "node:http";
import crypto from "node:crypto";
import { hashCode } from "./codes.js";
import { verifyRequest, AuthError } from "./auth.js";
import { log } from "./logger.js";

const MAX_BODY_BYTES = 64 * 1024; // control messages are small; file data gets its own endpoint later

// Simple brute-force protection for enrollment: max 10 attempts per IP per 15 minutes
const enrollAttempts = new Map();
function tooManyEnrollAttempts(ip) {
  const now = Date.now();
  const recent = (enrollAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  recent.push(now);
  enrollAttempts.set(ip, recent);
  return recent.length > 10;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function isValidPublicKey(pem) {
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export function createServer(db) {
  async function handleEnroll(req, res, body, ip) {
    if (tooManyEnrollAttempts(ip)) {
      log.warn(`Enrollment rate limit hit from ${ip}`);
      return send(res, 429, { error: "Too many attempts, try again later" });
    }

    const { code, deviceName, publicKey } = parseJson(body);
    if (typeof code !== "string" || typeof deviceName !== "string" || typeof publicKey !== "string") {
      return send(res, 400, { error: "code, deviceName and publicKey are required" });
    }
    if (deviceName.length < 1 || deviceName.length > 100) {
      return send(res, 400, { error: "deviceName must be 1-100 characters" });
    }
    if (!isValidPublicKey(publicKey)) {
      return send(res, 400, { error: "publicKey must be an Ed25519 public key" });
    }

    const codeHash = hashCode(code);
    const record = db.getCode(codeHash);
    // Same error for every failure so attackers can't tell which part was wrong
    const invalid = () => {
      log.warn(`Failed enrollment attempt from ${ip}`);
      return send(res, 403, { error: "Invalid or expired enrollment code" });
    };
    if (!record || record.used_at || new Date(record.expires_at) < new Date()) return invalid();

    const deviceId = `dev_${crypto.randomBytes(12).toString("base64url")}`;
    try {
      db.enrollDevice({ codeHash, deviceId, clientName: record.client_name, deviceName, publicKey, ip });
    } catch (err) {
      if (err.message === "CODE_ALREADY_USED") return invalid();
      throw err;
    }

    log.info(`Enrolled device "${deviceName}" for client "${record.client_name}" as ${deviceId} from ${ip}`);
    return send(res, 201, { deviceId, clientName: record.client_name });
  }

  function handleHeartbeat(req, res, body, ip) {
    const device = verifyRequest(req, body, db);
    const info = parseJson(body);
    db.recordHeartbeat(device.id, ip, {
      agentVersion: typeof info.agentVersion === "string" ? info.agentVersion.slice(0, 20) : null,
      filesTracked: Number.isInteger(info.filesTracked) ? info.filesTracked : null,
      pendingChanges: Number.isInteger(info.pendingChanges) ? info.pendingChanges : null,
    });
    log.debug(`Heartbeat from ${device.device_name} (${device.client_name})`);
    return send(res, 200, { ok: true, serverTime: Date.now() });
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    try {
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
      const body = await readBody(req);

      if (req.url === "/api/enroll") return await handleEnroll(req, res, body, ip);
      if (req.url === "/api/heartbeat") return handleHeartbeat(req, res, body, ip);

      return send(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof AuthError) {
        log.warn(`Rejected request from ${ip}: ${err.message}`);
        return send(res, 401, { error: "Unauthorized" }); // never tell the caller exactly why
      }
      if (err.status) return send(res, err.status, { error: err.message });
      log.error("Unexpected error", err);
      return send(res, 500, { error: "Internal error" });
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}