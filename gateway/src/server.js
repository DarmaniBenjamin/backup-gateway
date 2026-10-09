// HTTP API the agents talk to.
//   POST /api/enroll          (no login — uses a one-time code)
//   POST /api/heartbeat       (signed)
//   POST /api/key-exchange    (signed) agent and gateway swap X25519 public keys
//   POST /api/chunks/check    (signed) which of these chunks do you still need?
//   PUT  /api/chunks/:id      (signed) upload one encrypted chunk
//   POST /api/files/commit    (signed, encrypted) "this file version is made of these chunks"
//   GET  /api/restore/:job/manifest          (signed) encrypted list of files to restore
//   GET  /api/restore/:job/chunks/:chunkId   (signed) one chunk, re-encrypted for the restoring device
//   POST /api/commands/result                (signed) agent reports how a job went

import http from "node:http";
import crypto from "node:crypto";
import { hashCode } from "./codes.js";
import { verifyRequest, AuthError } from "./auth.js";
import { CHUNK_SIZE, chunkId as makeChunkId, open, seal } from "./crypto-box.js";
import { log } from "./logger.js";

const LIMIT_SMALL = 64 * 1024;           // control messages
const LIMIT_CHUNK = CHUNK_SIZE + 1024;   // one sealed chunk + a little overhead
const LIMIT_COMMIT = 8 * 1024 * 1024;    // file manifest (list of chunk IDs)
const MAX_CHECK_IDS = 1000;
const CHUNK_ID_RE = /^[a-f0-9]{64}$/;

// Simple brute-force protection for enrollment: max 10 attempts per IP per 15 minutes
const enrollAttempts = new Map();
function tooManyEnrollAttempts(ip) {
  const now = Date.now();
  const recent = (enrollAttempts.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  recent.push(now);
  enrollAttempts.set(ip, recent);
  return recent.length > 10;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    if (declared > limit) {
      reject(new HttpError(413, "Body too large"));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendBinary(res, status, buffer) {
  res.writeHead(status, {
    "Content-Type": "application/octet-stream",
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  res.end(buffer);
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
    throw new HttpError(400, "Invalid JSON");
  }
}

function isValidPublicKey(pem, type) {
  try {
    return crypto.createPublicKey(pem).asymmetricKeyType === type;
  } catch {
    return false;
  }
}

// File paths from agents must stay inside their backup folder
function isSafeRelPath(p) {
  if (typeof p !== "string" || p.length === 0 || p.length > 4096) return false;
  if (p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function createServer({ db, keys, storage }) {
  const jobChunkCache = new Map(); // job id -> Set of chunk IDs that job is allowed to download

  // Keys for a device, or an error if it hasn't done the key exchange
  function deviceKeys(device) {
    const k = keys.forDevice(device);
    if (!k) throw new HttpError(409, "Key exchange required");
    return k;
  }

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
    if (!isValidPublicKey(publicKey, "ed25519")) {
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

  function handleHeartbeat(res, device, body, ip) {
    const info = parseJson(body);
    db.recordHeartbeat(device.id, ip, {
      agentVersion: typeof info.agentVersion === "string" ? info.agentVersion.slice(0, 20) : null,
      filesTracked: Number.isInteger(info.filesTracked) ? info.filesTracked : null,
      pendingChanges: Number.isInteger(info.pendingChanges) ? info.pendingChanges : null,
    });
    log.debug(`Heartbeat from ${device.device_name} (${device.client_name})`);

    // Hand over any waiting jobs. Each one is encrypted for this device, so nobody in
    // between (a relay, a proxy) can read, change or inject commands.
    const k = keys.forDevice(device);
    const commands = k
      ? db.activeCommands(device.id).map((c) => {
          const p = JSON.parse(c.payload);
          const summary = { id: c.id, type: c.type, mode: p.mode, label: p.label, fileCount: p.files.length };
          const sealed = seal(k.encKey, Buffer.from(JSON.stringify(summary)), `command:${device.id}:${c.id}`);
          return { id: c.id, sealed: sealed.toString("base64") };
        })
      : [];
    return send(res, 200, { ok: true, serverTime: Date.now(), commands });
  }

  // A restore job that belongs to this device and isn't finished yet
  function getActiveJob(device, jobId) {
    const job = db.getCommand(jobId);
    if (!job || job.device_id !== device.id || job.type !== "restore") throw new HttpError(404, "Job not found");
    if (!["queued", "running"].includes(job.status)) throw new HttpError(409, `Job is ${job.status}`);
    return { job, payload: JSON.parse(job.payload) };
  }

  function handleRestoreManifest(res, device, jobId) {
    const { job, payload } = getActiveJob(device, jobId);
    const { encKey } = deviceKeys(device);
    db.startCommand(job.id);
    const manifest = {
      jobId: job.id,
      mode: payload.mode,
      label: payload.label,
      files: payload.files.map((f) => ({ relPath: f.relPath, size: f.size, sha256: f.sha256, chunkIds: f.chunkIds })),
    };
    log.info(`Restore job #${job.id} started by ${device.device_name} (${manifest.files.length} file(s))`);
    return sendBinary(res, 200, seal(encKey, Buffer.from(JSON.stringify(manifest)), `restore:${job.id}:manifest`));
  }

  function handleRestoreChunk(res, device, jobId, chunkIdParam) {
    const { job, payload } = getActiveJob(device, jobId);

    // Only chunks that are part of this job can be downloaded
    if (!jobChunkCache.has(job.id)) {
      jobChunkCache.set(job.id, new Set(payload.files.flatMap((f) => f.chunkIds)));
    }
    if (!jobChunkCache.get(job.id).has(chunkIdParam)) throw new HttpError(403, "Chunk is not part of this job");

    // Chunks are stored encrypted for the device that backed them up. Decrypt with that
    // device's keys, check it, then re-encrypt for the device doing the restore.
    // This is what lets a brand-new device restore a dead device's files.
    const source = db.getDevice(payload.sourceDeviceId);
    const sourceKeys = source && keys.forDevice(source);
    if (!sourceKeys) throw new HttpError(500, "Source device keys unavailable");

    let plaintext;
    try {
      plaintext = open(sourceKeys.encKey, storage.readChunk(source.id, chunkIdParam), `chunk:${chunkIdParam}`);
      if (makeChunkId(sourceKeys.idKey, plaintext) !== chunkIdParam) throw new Error("mismatch");
    } catch {
      log.error(`Restore job #${job.id}: stored chunk ${chunkIdParam.slice(0, 12)}… is damaged or missing`);
      throw new HttpError(500, "Stored chunk is damaged or missing");
    }

    const { encKey } = deviceKeys(device);
    return sendBinary(res, 200, seal(encKey, plaintext, `restore:${job.id}:${chunkIdParam}`));
  }

  function handleCommandResult(res, device, body) {
    const { commandId, ok, restored, failed, errors } = parseJson(body);
    const job = db.getCommand(commandId);
    if (!job || job.device_id !== device.id) throw new HttpError(404, "Job not found");
    const result = {
      restored: Number.isInteger(restored) ? restored : 0,
      failed: Number.isInteger(failed) ? failed : 0,
      errors: Array.isArray(errors) ? errors.slice(0, 20).map((e) => String(e).slice(0, 300)) : [],
    };
    db.finishCommand(job.id, ok ? "done" : "failed", result);
    jobChunkCache.delete(job.id);
    const line = `Restore job #${job.id} on ${device.device_name}: ${ok ? "done" : "FAILED"} — ${result.restored} restored, ${result.failed} failed`;
    if (ok) log.info(line);
    else log.warn(line);
    return send(res, 200, { ok: true });
  }

  function handleKeyExchange(res, device, body) {
    const { kxPublicKey } = parseJson(body);
    if (typeof kxPublicKey !== "string" || !isValidPublicKey(kxPublicKey, "x25519")) {
      throw new HttpError(400, "kxPublicKey must be an X25519 public key");
    }
    // A device's encryption key can be set once. Changing it later needs re-enrollment.
    if (device.kx_public_key && device.kx_public_key !== kxPublicKey) {
      log.warn(`Device ${device.id} tried to replace its encryption key — refused`);
      throw new HttpError(409, "Encryption key already set for this device");
    }
    if (!device.kx_public_key) {
      db.setKxPublicKey(device.id, kxPublicKey);
      log.info(`Key exchange completed for ${device.device_name} (${device.client_name})`);
    }
    return send(res, 200, { gatewayKxPublicKey: keys.publicKeyPem });
  }

  function handleCheckChunks(res, device, body) {
    const { chunkIds } = parseJson(body);
    if (!Array.isArray(chunkIds) || chunkIds.length > MAX_CHECK_IDS || !chunkIds.every((id) => CHUNK_ID_RE.test(id))) {
      throw new HttpError(400, `chunkIds must be an array of up to ${MAX_CHECK_IDS} chunk IDs`);
    }
    const missing = [...new Set(chunkIds)].filter((id) => !db.hasChunk(device.id, id));
    return send(res, 200, { missing });
  }

  function handlePutChunk(res, device, body, id) {
    const { encKey, idKey } = deviceKeys(device);
    if (db.hasChunk(device.id, id)) return send(res, 200, { ok: true, duplicate: true });

    // Decrypt to prove the chunk is genuine and matches its ID, then store it still encrypted
    let plaintext;
    try {
      plaintext = open(encKey, body, `chunk:${id}`);
    } catch {
      log.warn(`Rejected chunk from ${device.device_name}: failed decryption (tampered or wrong key)`);
      throw new HttpError(422, "Chunk failed integrity check");
    }
    if (makeChunkId(idKey, plaintext) !== id) {
      log.warn(`Rejected chunk from ${device.device_name}: content does not match its ID`);
      throw new HttpError(422, "Chunk failed integrity check");
    }

    storage.writeChunk(device.id, id, body);
    db.addChunk(device.id, id, plaintext.length, body.length);
    return send(res, 201, { ok: true });
  }

  function handleCommit(res, device, body) {
    const { encKey, idKey } = deviceKeys(device);
    let manifest;
    try {
      manifest = JSON.parse(open(encKey, body, `commit:${device.id}`, LIMIT_COMMIT * 2).toString("utf8"));
    } catch {
      throw new HttpError(422, "Manifest failed integrity check");
    }

    const { changeId, type, relPath, size, sha256, mtimeMs, chunkIds } = manifest;
    if (!Number.isInteger(changeId) || changeId < 1) throw new HttpError(400, "Bad changeId");
    if (!["added", "changed", "deleted"].includes(type)) throw new HttpError(400, "Bad type");
    if (!isSafeRelPath(relPath)) throw new HttpError(400, "Bad path");

    // Retries are safe: if we already saved this change, just return the same answer
    const existing = db.versionByChange(device.id, changeId);
    if (existing) return send(res, 200, { ok: true, version: existing.version_no, duplicate: true });

    if (type === "deleted") {
      const version = db.addVersion(device.id, { changeId, type, relPath });
      log.info(`${device.device_name}: ${relPath} deleted (v${version})`);
      return send(res, 201, { ok: true, version });
    }

    if (!Number.isInteger(size) || size < 0) throw new HttpError(400, "Bad size");
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256)) throw new HttpError(400, "Bad sha256");
    if (!Array.isArray(chunkIds) || !chunkIds.every((id) => CHUNK_ID_RE.test(id))) {
      throw new HttpError(400, "Bad chunkIds");
    }

    // Integrity check: rebuild the whole file from its chunks and confirm the SHA-256 matches
    const missing = chunkIds.filter((id) => !db.hasChunk(device.id, id));
    if (missing.length) throw new HttpError(409, `Missing ${missing.length} chunk(s)`);

    const hash = crypto.createHash("sha256");
    let total = 0;
    for (const id of chunkIds) {
      let plaintext = null;
      try {
        plaintext = open(encKey, storage.readChunk(device.id, id), `chunk:${id}`);
        if (makeChunkId(idKey, plaintext) !== id) plaintext = null;
      } catch {
        plaintext = null;
      }
      if (!plaintext) {
        // Damaged on our disk (bad drive, bit rot): throw it away so the agent sends it again
        log.error(`Stored chunk ${id.slice(0, 12)}… for ${device.device_name} is corrupted — removed, agent will resend it`);
        storage.deleteChunk(device.id, id);
        db.removeChunk(device.id, id);
        throw new HttpError(409, "A stored chunk was corrupted and has been removed; resend it");
      }
      hash.update(plaintext);
      total += plaintext.length;
    }
    if (total !== size || hash.digest("hex") !== sha256) {
      log.warn(`${device.device_name}: ${relPath} failed integrity check — not saved`);
      throw new HttpError(422, "File failed integrity check");
    }

    const version = db.addVersion(device.id, {
      changeId, type, relPath, size, sha256,
      mtimeMs: Number.isFinite(mtimeMs) ? Math.round(mtimeMs) : null,
      chunkIds,
    });
    log.info(`${device.device_name}: ${relPath} ${type} (v${version}, ${chunkIds.length} chunk(s), sha256 verified)`);
    return send(res, 201, { ok: true, version });
  }

  const server = http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    try {
      const url = req.url;

      if (req.method === "POST" && url === "/api/enroll") {
        return await handleEnroll(req, res, await readBody(req, LIMIT_SMALL), ip);
      }

      // Everything below requires a signed request from an enrolled device
      let route, limit, chunkIdParam, jobIdParam, match;
      if (req.method === "POST" && url === "/api/heartbeat") [route, limit] = ["heartbeat", LIMIT_SMALL];
      else if (req.method === "POST" && url === "/api/key-exchange") [route, limit] = ["kx", LIMIT_SMALL];
      else if (req.method === "POST" && url === "/api/chunks/check") [route, limit] = ["check", LIMIT_SMALL * 2];
      else if (req.method === "POST" && url === "/api/files/commit") [route, limit] = ["commit", LIMIT_COMMIT];
      else if (req.method === "POST" && url === "/api/commands/result") [route, limit] = ["result", LIMIT_SMALL];
      else if (req.method === "GET" && (match = url.match(/^\/api\/restore\/(\d+)\/manifest$/))) {
        [route, limit, jobIdParam] = ["manifest", 0, Number(match[1])];
      } else if (req.method === "GET" && (match = url.match(/^\/api\/restore\/(\d+)\/chunks\/([a-f0-9]{64})$/))) {
        [route, limit, jobIdParam, chunkIdParam] = ["restore-chunk", 0, Number(match[1]), match[2]];
      } else if (req.method === "PUT" && url.startsWith("/api/chunks/")) {
        chunkIdParam = url.slice("/api/chunks/".length);
        if (!CHUNK_ID_RE.test(chunkIdParam)) return send(res, 400, { error: "Bad chunk ID" });
        [route, limit] = ["put", LIMIT_CHUNK];
      } else {
        return send(res, 404, { error: "Not found" });
      }

      const body = await readBody(req, limit);
      const device = verifyRequest(req, body, db);

      switch (route) {
        case "heartbeat": return handleHeartbeat(res, device, body, ip);
        case "kx": return handleKeyExchange(res, device, body);
        case "check": return handleCheckChunks(res, device, body);
        case "put": return handlePutChunk(res, device, body, chunkIdParam);
        case "commit": return handleCommit(res, device, body);
        case "result": return handleCommandResult(res, device, body);
        case "manifest": return handleRestoreManifest(res, device, jobIdParam);
        case "restore-chunk": return handleRestoreChunk(res, device, jobIdParam, chunkIdParam);
      }
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
  server.requestTimeout = 120_000;
  return server;
}