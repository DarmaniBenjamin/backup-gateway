// S3-compatible cloud storage with Object Lock (Backblaze B2, Wasabi, Amazon S3...): checking
// settings, testing a bucket, explaining errors, and the recovery catalog. The copying itself is
// in copies.js, which runs one copy per destination (the failsafe and each device's own).
//
// What goes into a bucket (the provider only ever sees encrypted data):
//   chunks/<device>/<ab>/<chunk id>   the chunks exactly as stored: already AES-256-GCM encrypted
//   catalog/<month>/<time>.bin        the gateway's database and keys, encrypted to the recovery
//                                     key (see recovery.js), so the gateway can be rebuilt
// Each object is locked for the chosen number of days; chunks still in use get their lock extended.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createS3, S3Error } from "./s3.js";

const DAY = 24 * 3600 * 1000;

export const PROVIDERS = {
  b2: { label: "Backblaze B2", endpointHint: "https://s3.us-west-004.backblazeb2.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com$/ },
  wasabi: { label: "Wasabi", endpointHint: "https://s3.us-east-1.wasabisys.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.wasabisys\.com$/ },
  aws: { label: "Amazon S3", endpointHint: "https://s3.us-east-1.amazonaws.com", regionFrom: /^https:\/\/s3\.([a-z0-9-]+)\.amazonaws\.com$/ },
  s3: { label: "Other S3-compatible storage", endpointHint: "https://storage.example.com", regionFrom: null },
};

export class CloudError extends Error {}

// Plain-language versions of what the storage service says
export function explain(err, stepName = "") {
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
      if (/locked test file|Extending/.test(stepName)) {
        return "the key isn't allowed to set locks. In Backblaze, make a new application key for this bucket with \"Read and Write\" access (keys made before the bucket had Object Lock, or with \"Write Only\", can't set locks).";
      }
      return `the key isn't allowed to do this (${err.message}). Make sure it's for this bucket and has "Read and Write" access.`;
    case "InvalidRequest":
    case "InvalidArgument":
      if (/lock|retention/i.test(err.message)) return "Object Lock isn't turned on for this bucket.";
      return `${err.message} (${err.code})`;
    case "NoSuchBucket":
      return `the storage says there's no such bucket (${err.message}). ${
        /^[0-9a-f]{24}$/i.test(err.bucket ?? "")
          ? "That looks like the Bucket ID. Use the Bucket Name instead (the name at the top of the bucket in Backblaze)."
          : "Check the bucket name is typed exactly as it's shown (capital letters count), that the endpoint is the one shown on the bucket's page, and that the key was made for this bucket."
      }`;
    case "RequestTimeTooSkewed":
      return "This computer's clock is wrong, so the storage service rejects its requests. Fix the date and time.";
    default:
      return `${err.message}${err.code ? ` (${err.code})` : ""}`;
  }
}

export function cleanCloudSettings(body) {
  const provider = String(body.provider ?? "");
  if (!PROVIDERS[provider]) throw new CloudError("Pick a storage provider.");
  // Backblaze shows the endpoint without https:// ("s3.us-west-004.backblazeb2.com"), so add it
  let endpoint = String(body.endpoint ?? "").trim().replace(/\/+$/, "");
  if (endpoint && !/^[a-z]+:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CloudError("That isn't a valid endpoint. It looks like s3.us-west-004.backblazeb2.com");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname))) {
    throw new CloudError("The endpoint must start with https://");
  }
  if (url.pathname !== "/" || url.search) throw new CloudError("The endpoint is just the address, without a bucket or path after it.");
  const derived = PROVIDERS[provider].regionFrom ? endpoint.match(PROVIDERS[provider].regionFrom)?.[1] : null;
  const region = String(body.region ?? "").trim() || derived || (provider === "s3" ? "us-east-1" : "");
  if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new CloudError("Couldn't tell the region from the endpoint. Check the endpoint address.");
  // The bucket name exactly as it's shown in the storage service (Backblaze allows capital letters,
  // e.g. "Protonic-Backups"). Requests use path-style addresses, so any case works.
  const bucket = String(body.bucket ?? "").trim().replace(/^s3:\/\//i, "").replace(/\/+$/, "");
  if (!bucket) throw new CloudError("Enter the bucket name.");
  const badChar = bucket.match(/[^A-Za-z0-9._-]/);
  if (badChar) {
    throw new CloudError(
      badChar[0] === " "
        ? "The bucket name can't have spaces in it. Copy the Bucket Name from the bucket's page in Backblaze."
        : `The bucket name can't have "${badChar[0]}" in it. Copy the Bucket Name from the bucket's page in Backblaze.`
    );
  }
  if (bucket.length < 3 || bucket.length > 63) throw new CloudError("A bucket name is 3 to 63 characters long. Copy the Bucket Name from the bucket's page.");
  const keyId = String(body.keyId ?? "").trim();
  const secret = String(body.secret ?? "").trim();
  if (!keyId || keyId.length > 128 || /\s/.test(keyId)) throw new CloudError("Enter the key ID.");
  if (!secret || secret.length > 256 || /\s/.test(secret)) throw new CloudError("Enter the application (secret) key.");
  const lockMode = body.lockMode === "GOVERNANCE" ? "GOVERNANCE" : "COMPLIANCE";
  const retentionDays = Number(body.retentionDays);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new CloudError("Lock backups for 1 to 3650 days.");
  return { provider, endpoint, region, bucket, keyId, secret, lockMode, retentionDays };
}

// Proves the settings work before anything is saved, one step at a time so a failure says
// exactly which permission is missing:
//   1. check Object Lock is on for the bucket (skipped if the storage or key can't answer)
//   2. upload a tiny test file with a one-day lock (needs: write files + write file retentions)
//   3. extend that lock a little, as the gateway does for backups still in use (write file retentions)
//   4. list the bucket (list files)
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CloudError) throw err;
    throw new CloudError(`${name}: ${explain(err, name)}`);
  }
}

export async function testCloud(settings) {
  const s3 = createS3({ endpoint: settings.endpoint, region: settings.region, bucket: settings.bucket, accessKeyId: settings.keyId, secretAccessKey: settings.secret, timeoutMs: 20_000 });
  const lockEnabled = await step("Checking Object Lock on the bucket", async () => {
    try {
      return await s3.objectLockEnabled();
    } catch (err) {
      // Some storage (and some keys) can't answer this question; the locked upload below is the real test
      if (err instanceof S3Error && ["AccessDenied", "NoSuchBucket", "NotImplemented", "MethodNotAllowed"].includes(err.code)) return null;
      throw err;
    }
  });
  if (lockEnabled === false) {
    throw new CloudError("Object Lock isn't turned on for this bucket. Turn it on in the bucket's settings (or make a new bucket with it on), then try again.");
  }
  const key = `gateway-check/${new Date().toISOString()}-${crypto.randomBytes(4).toString("hex")}.txt`;
  const body = Buffer.from("Connection test from the backup gateway. Safe to ignore; it unlocks after a day.\n");
  await step("Uploading a locked test file", () =>
    s3.putObject(key, body, { lockMode: settings.lockMode, lockUntil: new Date(Date.now() + DAY), contentType: "text/plain" })
  );
  await step("Extending a lock", () => s3.extendLock(key, settings.lockMode, new Date(Date.now() + DAY + 3600_000)));
  await step("Listing the bucket", () => s3.list("gateway-check/"));
  return { ok: true };
}

export const chunkKey = (deviceId, chunkId) => `chunks/${deviceId}/${chunkId.slice(0, 2)}/${chunkId}`;

// Everything needed to rebuild the gateway, in one file: a consistent copy of the database
// (made with VACUUM INTO, safe while the gateway runs) plus the gateway's private key.
// For a device's own copy (deviceId set), the database copy is cut down to that one device:
// a client's bucket never holds other clients' file names, devices or settings.
export function makeCatalog(conn, dataDir, { deviceId = null, destId = null } = {}) {
  const tmp = path.join(dataDir, `catalog-${crypto.randomBytes(6).toString("hex")}.db.tmp`);
  try {
    conn.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    if (deviceId) trimToDevice(tmp, deviceId, destId);
    const files = [
      { name: "gateway.db", data: fs.readFileSync(tmp) },
      { name: "gateway-kx-key.pem", data: fs.readFileSync(path.join(dataDir, "gateway-kx-key.pem")) },
    ];
    const header = Buffer.from(
      JSON.stringify({
        format: "backup-gateway-catalog", version: 2, createdAt: new Date().toISOString(),
        destination: destId, device: deviceId, files: files.map((f) => ({ name: f.name, size: f.data.length })),
      })
    );
    const len = Buffer.alloc(4);
    len.writeUInt32BE(header.length);
    return zlib.gzipSync(Buffer.concat([len, header, ...files.map((f) => f.data)]));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Removes everything that isn't about this device (and this destination) from a database copy,
// then VACUUMs it so the removed rows aren't left behind in free pages
function trimToDevice(file, deviceId, destId) {
  const d = new DatabaseSync(file);
  try {
    const tables = d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
    const columns = (t) => d.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name);
    d.exec("PRAGMA foreign_keys = OFF; BEGIN");
    for (const t of tables) {
      const cols = columns(t);
      if (t === "devices") d.prepare("DELETE FROM devices WHERE id <> ?").run(deviceId);
      else if (t === "offsite_destinations") d.prepare("DELETE FROM offsite_destinations WHERE id <> ?").run(destId);
      else if (cols.includes("dest_id")) d.prepare(`DELETE FROM "${t}" WHERE dest_id <> ?`).run(destId);
      else if (cols.includes("device_id")) d.prepare(`DELETE FROM "${t}" WHERE device_id IS NULL OR device_id <> ?`).run(deviceId);
    }
    // Nothing gateway-wide: other enrollments, the audit log, sessions, the old single off-site setup
    for (const t of ["enrollment_codes", "audit_log", "admin_sessions", "cloud_config", "cloud_objects", "cloud_catalogs"]) {
      if (tables.includes(t)) d.exec(`DELETE FROM "${t}"`);
    }
    d.exec("COMMIT");
    d.exec("VACUUM");
  } finally {
    d.close();
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
