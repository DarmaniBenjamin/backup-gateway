// Off-site copy: sends every backed-up chunk to S3-compatible cloud storage (Backblaze B2,
// Wasabi, Amazon S3...) with Object Lock, so even someone who takes over the gateway or the
// cloud account can't delete or change the backups until their lock runs out.
//
// What goes up (the provider only ever sees encrypted data):
//   chunks/<device>/<ab>/<chunk id>   the chunks exactly as stored: already AES-256-GCM encrypted
//   catalog/<time>.bin                the gateway's database and keys, encrypted to the recovery
//                                     key (see recovery.js), so the gateway can be rebuilt
// Only "ok" versions are sent. Quarantined or rejected files never leave the gateway.
//
// Locks: each object is locked for the chosen number of days. Chunks that are still part of a
// backup get their lock extended before it runs out, so current backups are always protected.
// A new catalog goes up after new data, and at least once a day.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createS3, S3Error } from "./s3.js";
import { createRecoveryKey, sealForRecovery } from "./recovery.js";
import { log } from "../logger.js";

const DAY = 24 * 3600 * 1000;
const PASS_EVERY_MS = 60_000;
const FULL_SCAN_EVERY_MS = 6 * 3600 * 1000;
const CATALOG_EVERY_MS = DAY;
const CATALOG_MIN_GAP_MS = 15 * 60 * 1000;
const UPLOADS_AT_ONCE = 4;

export const PROVIDERS = {
  b2: { label: "Backblaze B2", endpointHint: "https://s3.us-west-004.backblazeb2.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com$/ },
  wasabi: { label: "Wasabi", endpointHint: "https://s3.us-east-1.wasabisys.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.wasabisys\.com$/ },
  aws: { label: "Amazon S3", endpointHint: "https://s3.us-east-1.amazonaws.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.amazonaws\.com$/ },
  s3: { label: "Other S3-compatible storage", endpointHint: "https://storage.example.com", regionFrom: null },
};

export class CloudError extends Error {}

// Plain-language versions of what the storage service says
function explain(err) {
  if (!(err instanceof S3Error)) {
    const m = err.cause?.code || err.code || err.message;
    if (/ENOTFOUND|EAI_AGAIN/.test(m)) return "Can't find that storage address. Check the endpoint, and that this computer is online.";
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|didn't answer/.test(m)) return "Can't reach the storage service right now. Check the endpoint and the internet connection.";
    if (/CERT|SSL|TLS/i.test(m)) return "The storage service's security certificate isn't valid for that address.";
    return err.message;
  }
  switch (err.code) {
    case "InvalidAccessKeyId":
    case "SignatureDoesNotMatch":
    case "AuthorizationHeaderMalformed":
      return "The key ID or application key is wrong (or the region doesn't match the endpoint).";
    case "AccessDenied":
      return "The key isn't allowed to do this. It needs: list files, read files, write files, read and write file retentions (on this bucket).";
    case "NoSuchBucket":
      return "That bucket doesn't exist at this endpoint.";
    case "RequestTimeTooSkewed":
      return "This computer's clock is wrong, so the storage service rejects its requests. Fix the date and time.";
    default:
      return `${err.message}${err.code ? ` (${err.code})` : ""}`;
  }
}

export function cleanCloudSettings(body) {
  const provider = String(body.provider ?? "");
  if (!PROVIDERS[provider]) throw new CloudError("Pick a storage provider.");
  const endpoint = String(body.endpoint ?? "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CloudError("The endpoint must be a full address, like https://s3.us-west-004.backblazeb2.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new CloudError("The endpoint must start with https://");
  }
  if (url.pathname !== "/" || url.search) throw new CloudError("The endpoint is just the address, without a bucket or path after it.");
  const derived = PROVIDERS[provider].regionFrom ? endpoint.match(PROVIDERS[provider].regionFrom)?.[1] : null;
  const region = String(body.region ?? "").trim() || derived || (provider === "s3" ? "us-east-1" : "");
  if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new CloudError("Couldn't tell the region from the endpoint. Check the endpoint address.");
  const bucket = String(body.bucket ?? "").trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new CloudError("That isn't a valid bucket name.");
  const keyId = String(body.keyId ?? "").trim();
  const secret = String(body.secret ?? "").trim();
  if (!keyId || keyId.length > 128 || /\s/.test(keyId)) throw new CloudError("Enter the key ID.");
  if (!secret || secret.length > 256 || /\s/.test(secret)) throw new CloudError("Enter the application (secret) key.");
  const lockMode = body.lockMode === "GOVERNANCE" ? "GOVERNANCE" : "COMPLIANCE";
  const retentionDays = Number(body.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new CloudError("Lock backups for 1 to 3650 days.");
  return { provider, endpoint, region, bucket, keyId, secret, lockMode, retentionDays };
}

// Proves the settings work before anything is saved: right key, bucket has Object Lock on,
// and the key can upload a locked file (a tiny test file, locked for one day).
export async function testCloud(settings) {
  const s3 = createS3({ endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, accessKeyId: settings.keyId, secretAccessKey: settings.secret, timeoutMs: 20_000 });
  try {
    if (!(await s3.objectLockEnabled())) {
      throw new CloudError("Object Lock isn't turned on for this bucket. Turn it on in the bucket's settings (or make a new bucket with it on), then try again.");
    }
    const key = `gateway-check/${new Date().toISOString()}-${crypto.randomBytes(4).toString("hex")}.txt`;
    const body = Buffer.from("Connection test from the backup gateway. Safe to ignore; it unlocks after a day.\n");
    await s3.putObject(key, body, { lockMode: settings.lockMode, lockUntil: new Date(Date.now() + DAY), contentType: "text/plain" });
    const head = await s3.headObject(key);
    if (!head.lockUntil) throw new CloudError("The test file uploaded but didn't get a lock. Check that Object Lock is on for this bucket.");
    return { ok: true };
  } catch (err) {
    if (err instanceof CloudError) throw err;
    throw new CloudError(explain(err));
  }
}

const chunkKey = (deviceId, chunkId) => `chunks/${deviceId}/${chunkId.slice(0, 2)}/${chunkId}`;

// Everything needed to rebuild the gateway, in one file: a consistent copy of the database
// (made with VACUUM INTO, safe while the gateway runs) plus the gateway's private key
function makeCatalog(conn, dataDir) {
  const tmp = path.join(dataDir, `catalog-${crypto.randomBytes(6).toString("hex")}.db.tmp`);
  try {
    conn.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const files = [
      { name: "gateway.db", data: fs.readFileSync(tmp) },
      { name: "gateway-kx-key.pem", data: fs.readFileSync(path.join(dataDir, "gateway-kx-key.pem")) },
    ];
    const header = Buffer.from(
      JSON.stringify({ format: "backup-gateway-catalog", version: 1, createdAt: new Date().toISOString(), files: files.map((f) => ({ name: f.name, size: f.data.length })) })
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    return zlib.gzipSync(Buffer.concat([len, header, ...files.map((f) => f.data)]));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function readCatalog(gz) {
  const buf = zlib.gunzipSync(gz);
  const len = buf.readUInt32BE(0);
  const header = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
  if (header.format !== "backup-gateway-catalog") throw new Error("Not a gateway catalog");
  let at = 4 + len;
  const files = {};
  for (const f of header.files) {
    files[f.name] = buf.subarray(at, at + f.size);
    at += f.size;
  }
  return { header, files };
}

export function createOffsite({ db, dataDir, storage }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS cloud_config (
      id              INTEGER PRIMARY KEY CHECK (id = 1),
      provider        TEXT NOT NULL,
      endpoint        TEXT NOT NULL,
      region          TEXT NOT NULL,
      bucket          TEXT NOT NULL,
      key_id          TEXT NOT NULL,
      secret          TEXT NOT NULL,
      lock_mode       TEXT NOT NULL,
      retention_days  INTEGER NOT NULL,
      recovery_public TEXT NOT NULL,
      recovery_fp     TEXT NOT NULL,
      paused          INTEGER NOT NULL DEFAULT 0,
      connected_at    TEXT NOT NULL,
      connected_by    TEXT
    );
    CREATE TABLE IF NOT EXISTS cloud_objects (
      device_id    TEXT NOT NULL,
      chunk_id     TEXT NOT NULL,
      size         INTEGER NOT NULL,
      uploaded_at  TEXT NOT NULL,
      locked_until TEXT NOT NULL,
      PRIMARY KEY (device_id, chunk_id)
    );
    CREATE TABLE IF NOT EXISTS cloud_meta (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS cloud_catalogs (
      key          TEXT PRIMARY KEY,
      size         INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      locked_until TEXT NOT NULL
    );
  `);
  const q = {
    config: conn.prepare("SELECT * FROM cloud_config WHERE id = 1"),
    saveConfig: conn.prepare(`
      INSERT INTO cloud_config (id, provider, endpoint, region, bucket, key_id, secret, lock_mode, retention_days,
        recovery_public, recovery_fp, paused, connected_at, connected_by)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`),
    setKeys: conn.prepare("UPDATE cloud_config SET key_id = ?, secret = ? WHERE id = 1"),
    setPaused: conn.prepare("UPDATE cloud_config SET paused = ? WHERE id = 1"),
    deleteConfig: conn.prepare("DELETE FROM cloud_config WHERE id = 1"),
    okVersionsSince: conn.prepare(
      "SELECT id, device_id, chunk_ids FROM file_versions WHERE status = 'ok' AND chunk_ids IS NOT NULL AND id > ? ORDER BY id"
    ),
    isUploaded: conn.prepare("SELECT 1 FROM cloud_objects WHERE device_id = ? AND chunk_id = ?"),
    boxSize: conn.prepare("SELECT box_size FROM chunks WHERE device_id = ? AND chunk_id = ?"),
    addObject: conn.prepare(
      "INSERT OR REPLACE INTO cloud_objects (device_id, chunk_id, size, uploaded_at, locked_until) VALUES (?, ?, ?, ?, ?)"
    ),
    expiring: conn.prepare("SELECT device_id, chunk_id FROM cloud_objects WHERE locked_until < ? ORDER BY locked_until LIMIT 5000"),
    setLock: conn.prepare("UPDATE cloud_objects SET locked_until = ? WHERE device_id = ? AND chunk_id = ?"),
    totals: conn.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, MIN(locked_until) AS soonest FROM cloud_objects"),
    addCatalog: conn.prepare("INSERT INTO cloud_catalogs (key, size, created_at, locked_until) VALUES (?, ?, ?, ?)"),
    lastCatalog: conn.prepare("SELECT * FROM cloud_catalogs ORDER BY created_at DESC LIMIT 1"),
    getMeta: conn.prepare("SELECT value FROM cloud_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO cloud_meta (name, value) VALUES (?, ?)"),
    forgetUploads: conn.prepare("DELETE FROM cloud_objects"),
    forgetCatalogs: conn.prepare("DELETE FROM cloud_catalogs"),
    openCloudAlert: conn.prepare("SELECT id FROM alerts WHERE kind = 'cloud' AND acknowledged_at IS NULL LIMIT 1"),
  };

  const state = {
    running: false,
    cursor: 0, // highest file version already looked at
    lastFullScan: 0,
    pending: null, // { chunks, bytes } still to upload, from the last scan
    lastPassAt: null,
    lastSuccessAt: null,
    lastError: null,
    failingSince: null,
    failures: 0,
    nextPassAt: 0,
    uploadedSinceCatalog: 0,
    current: null, // what a running pass is doing, for the UI
  };
  let timer = null;

  const config = () => q.config.get();
  const s3For = (c) =>
    createS3({ endpoint: c.endpoint, region: c.region, bucket: c.bucket, accessKeyId: c.key_id, secretAccessKey: c.secret });

  // Chunks of "ok" versions that aren't in the cloud yet
  function scan(fromId) {
    const want = new Map(); // "device chunk" -> [device, chunk]
    const referenced = fromId === 0 ? new Set() : null;
    let maxId = fromId;
    for (const v of q.okVersionsSince.iterate(fromId)) {
      maxId = v.id;
      for (const id of JSON.parse(v.chunk_ids)) {
        const k = `${v.device_id} ${id}`;
        referenced?.add(k);
        if (!want.has(k) && !q.isUploaded.get(v.device_id, id)) want.set(k, [v.device_id, id]);
      }
    }
    return { todo: [...want.values()], maxId, referenced };
  }

  async function uploadAll(c, s3, todo) {
    let i = 0;
    let done = 0;
    const lockUntil = () => new Date(Date.now() + c.retention_days * DAY);
    state.current = { action: "Uploading", done: 0, total: todo.length };
    async function worker() {
      while (i < todo.length) {
        const [deviceId, chunkId] = todo[i++];
        let box;
        try {
          box = storage.readChunk(deviceId, chunkId);
        } catch {
          log.warn(`Off-site: chunk ${chunkId.slice(0, 12)}… of ${deviceId} is missing on the gateway; run an integrity check`);
          continue;
        }
        const until = lockUntil();
        await s3.putObject(chunkKey(deviceId, chunkId), box, { lockMode: c.lock_mode, lockUntil: until });
        q.addObject.run(deviceId, chunkId, box.length, new Date().toISOString(), until.toISOString());
        done++;
        state.current.done = done;
      }
    }
    await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, todo.length) }, worker));
    return done;
  }

  // Keep chunks that are still part of a backup locked: extend locks that run out soon
  async function renewLocks(c, s3, referenced) {
    const renewBefore = Math.max(2, Math.ceil(c.retention_days / 4)) * DAY;
    const rows = q.expiring.all(new Date(Date.now() + renewBefore).toISOString()).filter((r) => referenced.has(`${r.device_id} ${r.chunk_id}`));
    if (!rows.length) return 0;
    state.current = { action: "Extending locks", done: 0, total: rows.length };
    let n = 0;
    for (const r of rows) {
      const until = new Date(Date.now() + c.retention_days * DAY);
      await s3.extendLock(chunkKey(r.device_id, r.chunk_id), c.lock_mode, until);
      q.setLock.run(until.toISOString(), r.device_id, r.chunk_id);
      state.current.done = ++n;
    }
    return n;
  }

  async function uploadCatalog(c, s3) {
    state.current = { action: "Uploading the catalog" };
    const box = sealForRecovery(c.recovery_public, makeCatalog(conn, dataDir));
    const now = new Date();
    const key = `catalog/${now.toISOString().slice(0, 7)}/${now.toISOString()}.bin`;
    // Catalogs stay locked a little longer than chunks, so a locked one always exists
    const until = new Date(Date.now() + (c.retention_days + 2) * DAY);
    await s3.putObject(key, box, { lockMode: c.lock_mode, lockUntil: until });
    q.addCatalog.run(key, box.length, now.toISOString(), until.toISOString());
    state.uploadedSinceCatalog = 0;
    log.info(`Off-site: catalog uploaded (${(box.length / 1024).toFixed(0)} KB, encrypted to recovery key ${c.recovery_fp})`);
  }

  async function pass({ full = false } = {}) {
    const c = config();
    if (!c || c.paused || state.running) return;
    state.running = true;
    state.lastPassAt = new Date().toISOString();
    try {
      const s3 = s3For(c);
      const doFull = full || Date.now() - state.lastFullScan > FULL_SCAN_EVERY_MS;
      const { todo, maxId, referenced } = scan(doFull ? 0 : state.cursor);
      state.pending = {
        chunks: todo.length,
        bytes: todo.reduce((sum, [d, id]) => sum + (q.boxSize.get(d, id)?.box_size ?? 0), 0),
      };
      if (todo.length) log.info(`Off-site: uploading ${todo.length} chunk(s)`);
      const sent = await uploadAll(c, s3, todo);
      state.cursor = Math.max(state.cursor, maxId);
      state.pending = { chunks: 0, bytes: 0 };
      state.uploadedSinceCatalog += sent;
      if (sent) log.info(`Off-site: ${sent} chunk(s) uploaded and locked for ${c.retention_days} day(s)`);
      if (doFull) {
        const renewed = await renewLocks(c, s3, referenced);
        if (renewed) log.info(`Off-site: kept ${renewed} chunk(s) locked for another ${c.retention_days} day(s)`);
        state.lastFullScan = Date.now();
      }
      const last = q.lastCatalog.get();
      const age = last ? Date.now() - new Date(last.created_at).getTime() : Infinity;
      if ((state.uploadedSinceCatalog > 0 && age > CATALOG_MIN_GAP_MS) || age > CATALOG_EVERY_MS) await uploadCatalog(c, s3);

      state.lastSuccessAt = new Date().toISOString();
      state.lastError = null;
      state.failingSince = null;
      state.failures = 0;
      state.nextPassAt = Date.now() + PASS_EVERY_MS;
    } catch (err) {
      const message = explain(err);
      state.lastError = { message, at: new Date().toISOString() };
      state.failingSince ??= Date.now();
      state.failures++;
      // Wait longer after each failure (1, 2, 4... up to 30 minutes) instead of hammering the service
      state.nextPassAt = Date.now() + Math.min(30 * 60_000, PASS_EVERY_MS * 2 ** (state.failures - 1));
      log.error(`Off-site copy failed: ${message}`);
      if (Date.now() - state.failingSince > 3600_000 && !q.openCloudAlert.get()) {
        db.addAlert(null, "cloud", `Off-site backups have been failing for over an hour: ${message}`);
      }
    } finally {
      state.running = false;
      state.current = null;
    }
  }

  function tick() {
    if (Date.now() >= state.nextPassAt) pass().catch(() => {});
  }

  return {
    start() {
      timer = setInterval(tick, 15_000);
      timer.unref();
      setTimeout(tick, 5_000).unref();
    },
    stop() {
      clearInterval(timer);
    },

    status() {
      const c = config();
      if (!c) return { connected: false, providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, endpointHint: v.endpointHint }])) };
      const totals = q.totals.get();
      const last = q.lastCatalog.get();
      return {
        connected: true,
        provider: c.provider,
        providerLabel: PROVIDERS[c.provider]?.label ?? c.provider,
        endpoint: c.endpoint,
        region: c.region,
        bucket: c.bucket,
        keyId: c.key_id,
        lockMode: c.lock_mode,
        retentionDays: c.retention_days,
        recoveryFingerprint: c.recovery_fp,
        paused: !!c.paused,
        connectedAt: c.connected_at,
        connectedBy: c.connected_by,
        uploaded: { chunks: totals.n, bytes: totals.bytes, soonestUnlock: totals.soonest },
        pending: state.pending,
        lastCatalog: last ? { at: last.created_at, size: last.size, lockedUntil: last.locked_until } : null,
        running: state.running,
        current: state.current,
        lastPassAt: state.lastPassAt,
        lastSuccessAt: state.lastSuccessAt,
        lastError: state.lastError,
      };
    },

    // Saves new settings (already tested) and makes the recovery key. Returns the key ONCE.
    connect(settings, admin) {
      if (config()) throw new CloudError("Off-site backups are already connected. Disconnect first to switch storage.");
      // A different bucket than last time: nothing is up there yet, so start the record afresh
      const target = `${settings.endpoint}/${settings.bucket}`;
      if (q.getMeta.get("target")?.value !== target) {
        q.forgetUploads.run();
        q.forgetCatalogs.run();
        q.setMeta.run("target", target);
      }
      const recovery = createRecoveryKey();
      q.saveConfig.run(
        settings.provider, settings.endpoint, settings.region, settings.bucket, settings.keyId, settings.secret,
        settings.lockMode, settings.retentionDays, recovery.publicKey, recovery.fingerprint, new Date().toISOString(), admin
      );
      Object.assign(state, { cursor: 0, lastFullScan: 0, nextPassAt: Date.now() + 3000, failures: 0, lastError: null, failingSince: null, uploadedSinceCatalog: 1 });
      log.info(`Off-site backups connected to ${settings.bucket} (${PROVIDERS[settings.provider].label}), recovery key ${recovery.fingerprint}`);
      return { recoveryKey: recovery.recoveryKey, fingerprint: recovery.fingerprint };
    },

    // Swap the access key (e.g. it was rotated). Tested first by the caller.
    replaceKey(keyId, secret) {
      q.setKeys.run(keyId, secret);
      state.nextPassAt = Date.now();
    },

    setPaused(paused) {
      q.setPaused.run(paused ? 1 : 0);
      if (!paused) state.nextPassAt = Date.now();
    },

    syncNow() {
      state.nextPassAt = 0;
      state.lastFullScan = 0; // also re-check everything and extend locks
    },

    // Stops sending. Nothing in the bucket is touched (it's locked anyway); the record of what
    // was uploaded is kept, so reconnecting the same bucket doesn't upload it all again.
    disconnect() {
      q.deleteConfig.run();
    },

    config,
    pass,
  };
}
