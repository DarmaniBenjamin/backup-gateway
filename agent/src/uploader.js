// Sends queued changes to the gateway, oldest first.
//
// For each changed file:
//   1. Read it in 1 MiB chunks, fingerprint each chunk (HMAC-SHA256) and the whole file (SHA-256)
//   2. Ask the gateway which chunks it doesn't have yet
//   3. Compress + encrypt (AES-256-GCM) only the missing chunks and upload them
//   4. Send an encrypted manifest: "version N of this file = these chunks, this SHA-256"
// The gateway rebuilds the file from its chunks and checks the SHA-256 before accepting it.

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { readChunks } from "./chunker.js";
import { chunkId, seal } from "./crypto-box.js";
import { log } from "./logger.js";

const CHECK_BATCH = 1000;
const RETRY_MS = 15_000;

class FileChangedError extends Error {}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function createUploader({ db, tracker, connection }) {
  const { client, auth } = connection;
  let running = false;
  let again = false;

  async function commit(manifest, keys) {
    const box = seal(keys.encKey, Buffer.from(JSON.stringify(manifest)), `commit:${auth.deviceId}`);
    return client.signedPostBinary("/api/files/commit", box, auth);
  }

  async function uploadFile(change, keys) {
    const absPath = tracker.toAbs(change.rel_path);
    if (!absPath) return { skipped: "its folder is no longer backed up" };

    let stats;
    try {
      stats = await fs.stat(absPath);
    } catch (err) {
      if (err.code === "ENOENT") return { skipped: "file no longer exists" };
      throw err;
    }

    // Pass 1: fingerprint every chunk and the whole file
    const ids = [];
    const fileHash = crypto.createHash("sha256");
    let size = 0;
    for await (const data of readChunks(absPath)) {
      ids.push(chunkId(keys.idKey, data));
      fileHash.update(data);
      size += data.length;
    }
    const sha256 = fileHash.digest("hex");

    // Ask which chunks the gateway still needs (deduplication)
    const missing = new Set();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += CHECK_BATCH) {
      const result = await client.signedPost("/api/chunks/check", { chunkIds: unique.slice(i, i + CHECK_BATCH) }, auth);
      result.missing.forEach((id) => missing.add(id));
    }

    // Pass 2: encrypt and upload only the missing chunks
    let index = 0;
    let sentBytes = 0;
    const uploaded = new Set();
    for await (const data of readChunks(absPath)) {
      const id = chunkId(keys.idKey, data);
      if (id !== ids[index]) throw new FileChangedError(); // file was edited while we were uploading it
      if (missing.has(id) && !uploaded.has(id)) {
        const box = seal(keys.encKey, data, `chunk:${id}`);
        await client.signedPutBinary(`/api/chunks/${id}`, box, auth);
        uploaded.add(id);
        sentBytes += box.length;
      }
      index++;
    }
    if (index !== ids.length) throw new FileChangedError();

    const result = await commit(
      { changeId: change.id, type: change.type, relPath: change.rel_path, size, sha256, mtimeMs: stats.mtimeMs, chunkIds: ids },
      keys
    );
    return {
      version: result.version,
      chunks: ids.length,
      newChunks: uploaded.size,
      sentBytes,
      size,
      quarantined: !!result.quarantined,
      reasons: result.reasons ?? [],
    };
  }

  async function processChange(change, keys) {
    // If the same file changed again later, only the newest version matters
    if (change.type !== "deleted" && db.hasLaterPending(change.rel_path, change.id)) {
      db.setChangeStatus(change.id, "superseded");
      return;
    }

    if (change.type === "deleted") {
      const result = await commit({ changeId: change.id, type: "deleted", relPath: change.rel_path }, keys);
      db.markChangeSent(change.id, result.version);
      if (result.quarantined) log.warn(`sent     ${change.rel_path} deleted — QUARANTINED by the gateway (${result.reasons.join(", ")})`);
      else log.info(`sent     ${change.rel_path} deleted (v${result.version})`);
      return;
    }

    try {
      const r = await uploadFile(change, keys);
      if (r.skipped) {
        db.setChangeStatus(change.id, "skipped");
        log.debug(`skipped  ${change.rel_path}: ${r.skipped}`);
        return;
      }
      db.markChangeSent(change.id, r.version);
      if (r.quarantined) {
        log.warn(`sent     ${change.rel_path} — QUARANTINED by the gateway (${r.reasons.join(", ")})`);
      } else {
        log.info(
          `sent     ${change.rel_path} v${r.version} — ${r.chunks} chunk(s), ${r.newChunks} new, ` +
            `${formatSize(r.sentBytes)} uploaded for a ${formatSize(r.size)} file`
        );
      }
    } catch (err) {
      if (err instanceof FileChangedError) {
        // The watcher will report the new edit; this older change is no longer needed
        db.setChangeStatus(change.id, "superseded");
        log.info(`file changed during upload, will send the newer version: ${change.rel_path}`);
        return;
      }
      throw err;
    }
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        if (db.countPending() === 0) break;
        const keys = await connection.ensureKeys();
        let batch;
        while ((batch = db.nextPending(50)).length > 0) {
          for (const change of batch) await processChange(change, keys);
        }
      } while (again);
    } catch (err) {
      if (err.security) log.error(err.message);
      else if (err.status) log.error(`Upload failed: ${err.message}`);
      else log.warn(`Upload paused, gateway unreachable (${err.cause?.code || err.message}). Will retry.`);
    } finally {
      running = false;
    }
  }

  // Run soon after changes, and retry regularly in case the gateway was offline
  let debounce = null;
  const timer = setInterval(run, RETRY_MS);

  return {
    trigger() {
      clearTimeout(debounce);
      debounce = setTimeout(run, 1000);
    },
    stop() {
      clearInterval(timer);
      clearTimeout(debounce);
    },
    run,
  };
}