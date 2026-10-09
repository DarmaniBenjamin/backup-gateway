// Decides what really changed by comparing the disk with the database.
// The watcher only says "look at this path" — the tracker works out the truth.

import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hasher.js";
import { isIgnored } from "./ignore.js";
import { log } from "./logger.js";

// Database paths always use "/" so they're the same on Windows and Linux
const toRel = (rootDir, absPath) => path.relative(rootDir, absPath).split(path.sep).join("/");
const toAbs = (rootDir, relPath) => path.join(rootDir, ...relPath.split("/"));

export function createTracker(rootDir, db, onChange) {
  function report(type, relPath, size, sha256) {
    db.recordChange(type, relPath, size, sha256);
    onChange({ type, relPath, size, sha256 });
  }

  // Look at one file on disk and compare it to what the database knows.
  async function checkFile(absPath, stats) {
    const relPath = toRel(rootDir, absPath);
    const known = db.getFile(relPath);

    // Quick check: same size and modified time = unchanged, no need to re-read it
    if (known && known.size === stats.size && known.mtime_ms === Math.round(stats.mtimeMs)) {
      return;
    }

    let sha256;
    try {
      sha256 = await hashFile(absPath);
    } catch (err) {
      // File vanished or is locked while we were reading it; the next event/scan will catch it
      log.warn(`Could not read ${relPath}: ${err.code || err.message}`);
      return;
    }

    db.saveFile(relPath, stats.size, stats.mtimeMs, sha256);

    if (!known) {
      report("added", relPath, stats.size, sha256);
    } else if (known.sha256 !== sha256) {
      report("changed", relPath, stats.size, sha256);
    }
    // else: timestamp changed but content is identical — nothing to back up
  }

  // Something at relPath is gone: a file, or a whole folder of files.
  function markGone(relPath) {
    const goneFiles = [];
    if (db.getFile(relPath)) goneFiles.push(relPath);
    goneFiles.push(...db.filesUnder(relPath));

    db.transaction(() => {
      for (const p of goneFiles) {
        db.removeFile(p);
        db.recordChange("deleted", p, null, null);
      }
    });
    for (const p of goneFiles) onChange({ type: "deleted", relPath: p, size: null, sha256: null });
  }

  // Walk a folder and check every file in it. Returns the set of files seen.
  async function scanFolder(absDir, seen) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Could not read folder ${toRel(rootDir, absDir) || "."}: ${err.code || err.message}`);
      return;
    }
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      if (isIgnored(absPath)) continue;
      if (entry.isSymbolicLink()) continue; // never follow links out of the backup folder
      if (entry.isDirectory()) {
        await scanFolder(absPath, seen);
      } else if (entry.isFile()) {
        seen?.add(toRel(rootDir, absPath));
        try {
          await checkFile(absPath, await fs.stat(absPath));
        } catch (err) {
          if (err.code !== "ENOENT") log.warn(`Could not check ${absPath}: ${err.message}`);
        }
      }
    }
  }

  return {
    // Called for every watcher hint. Works out what actually happened.
    async inspect(absPath) {
      if (isIgnored(absPath)) return;
      const relPath = toRel(rootDir, absPath);
      let stats;
      try {
        stats = await fs.lstat(absPath);
      } catch (err) {
        if (err.code === "ENOENT") return markGone(relPath);
        throw err;
      }
      if (stats.isSymbolicLink()) return;
      if (stats.isDirectory()) return scanFolder(absPath); // e.g. a folder moved in
      if (stats.isFile()) return checkFile(absPath, stats);
    },

    // Full scan at startup: catches everything that changed while the agent was off.
    async fullScan() {
      const seen = new Set();
      await scanFolder(rootDir, seen);
      const missing = db.allPaths().filter((p) => !seen.has(p));
      for (const p of missing) markGone(p);
    },

    toAbs: (relPath) => toAbs(rootDir, relPath),
  };
}