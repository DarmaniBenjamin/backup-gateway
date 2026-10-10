// Carries out restore jobs sent by the gateway.
//
// For each file in the job:
//   1. download its chunks (re-encrypted by the gateway for THIS device) and decrypt them
//   2. write them to a temporary file while calculating the SHA-256
//   3. only if the SHA-256 matches the backed-up version, move the file into place
//
// Modes:
//   copy      (default) restore into "_Restored/<date> job N/..." inside each file's backup folder.
//             Originals are never touched. Files from a folder this device doesn't have (e.g. a
//             replacement PC) go into the first backup folder's "_Restored", under the folder name.
//   overwrite put files back in their original locations (the folder must exist on this device).

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { open } from "./crypto-box.js";
import { log } from "./logger.js";

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// Turns "a/b/c.txt" into a real path inside rootDir, refusing anything that would escape it
function safeJoin(rootDir, relPath) {
  const parts = relPath.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Error(`Unsafe path: ${relPath}`);
  const full = path.resolve(rootDir, ...parts);
  const rel = path.relative(rootDir, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Unsafe path: ${relPath}`);
  return full;
}

function folderStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}`;
}

export function createRestorer({ db, connection, tracker }) {
  const { client, auth } = connection;
  const running = new Set();
  let queue = Promise.resolve();

  // Where a backed-up path ("Documents/a/b.txt") goes on this device
  function targetFor(relPath, mode, jobFolder) {
    const [name, ...rest] = relPath.split("/");
    const folder = tracker.folderByName(name);
    if (mode === "overwrite") {
      if (!folder) throw new Error(`the backup folder "${name}" isn't on this device`);
      return safeJoin(folder.path, rest.join("/"));
    }
    if (folder) return safeJoin(path.join(folder.path, "_Restored", jobFolder), rest.join("/"));
    const first = tracker.folders()[0];
    if (!first) throw new Error("this device has no backup folder to restore into — add one first");
    return safeJoin(path.join(first.path, "_Restored", jobFolder), relPath);
  }

  async function restoreFile(job, file, keys, target) {
    await fsp.mkdir(path.dirname(target), { recursive: true });

    // ".tmp" files are ignored by the watcher, so half-restored files are never backed up
    const tmp = `${target}.restoring-${crypto.randomBytes(4).toString("hex")}.tmp`;
    const hash = crypto.createHash("sha256");
    let size = 0;
    const out = fs.createWriteStream(tmp, { mode: 0o644 });
    try {
      for (const id of file.chunkIds) {
        const box = await client.signedGet(`/api/restore/${job.id}/chunks/${id}`, auth);
        const data = open(keys.encKey, box, `restore:${job.id}:${id}`);
        hash.update(data);
        size += data.length;
        if (!out.write(data)) await new Promise((r) => out.once("drain", r));
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));

      if (size !== file.size || hash.digest("hex") !== file.sha256) {
        throw new Error("SHA-256 check failed — file not restored");
      }
      await fsp.rename(tmp, target); // instant swap: the file is either fully restored or untouched
      return size;
    } catch (err) {
      out.destroy();
      await fsp.rm(tmp, { force: true });
      throw err;
    }
  }

  async function runJob(summary) {
    // Already done (e.g. our result didn't reach the gateway)? Just report it again.
    const previous = db.getJobDone(summary.id);
    if (previous) {
      await client.signedPost("/api/commands/result", { commandId: summary.id, ...previous }, auth);
      return;
    }

    log.info(`Restore job #${summary.id} received: ${summary.label} (${summary.fileCount} file(s), mode: ${summary.mode})`);
    const keys = await connection.ensureKeys();
    const manifestBox = await client.signedGet(`/api/restore/${summary.id}/manifest`, auth);
    const manifest = JSON.parse(open(keys.encKey, manifestBox, `restore:${summary.id}:manifest`, 64 * 1024 * 1024).toString("utf8"));

    const jobFolder = `${folderStamp()} job ${summary.id}`;

    let restored = 0;
    let bytes = 0;
    const errors = [];
    for (const file of manifest.files) {
      try {
        bytes += await restoreFile(summary, file, keys, targetFor(file.relPath, manifest.mode, jobFolder));
        restored++;
        log.info(`restored ${file.relPath} (${formatSize(file.size)}, sha256 verified)`);
      } catch (err) {
        errors.push(`${file.relPath}: ${err.message}`);
        log.error(`could not restore ${file.relPath}: ${err.message}`);
      }
    }

    const result = { ok: errors.length === 0, restored, failed: errors.length, errors };
    db.saveJobDone(summary.id, result);
    await client.signedPost("/api/commands/result", { commandId: summary.id, ...result }, auth);
    log.info(
      `Restore job #${summary.id} finished: ${restored} file(s), ${formatSize(bytes)} restored` +
        (errors.length ? `, ${errors.length} failed` : "") +
        (manifest.mode === "overwrite" ? " → original locations" : ` → "_Restored/${jobFolder}"`)
    );
  }

  return {
    // Called by the connection whenever the gateway hands over a job
    handle(command) {
      if (command.type !== "restore" || running.has(command.id)) return;
      running.add(command.id);
      queue = queue
        .then(() => runJob(command))
        .catch((err) => log.error(`Restore job #${command.id} stopped: ${err.message} (will retry)`))
        .finally(() => running.delete(command.id));
    },
  };
}