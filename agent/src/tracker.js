// Decides what really changed by comparing the disk with the database.
// The watcher only says "look at this path" — the tracker works out the truth.
//
// It handles several backup folders. Every path in the database starts with the folder's name:
// the file C:\Users\Anna\Documents\report.docx in the folder named "Documents" is stored as
// "Documents/report.docx".

import fs from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./hasher.js";
import { isIgnored } from "./ignore.js";
import { log } from "./logger.js";

// "*.mp4" / "Cache" / "~*" -> a case-insensitive regular expression matching one file or folder name
function compilePattern(pattern) {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

// "/Downloads" / "/Projects/Old" -> exactly that sub-folder of the backup folder (and everything in it).
// Windows and Mac ignore upper/lower case in paths, so the match does too there.
const PATHS_IGNORE_CASE = process.platform === "win32" || process.platform === "darwin";
const comparable = (p) => (PATHS_IGNORE_CASE ? p.toLowerCase() : p);

function splitExcludes(excludes) {
  const names = [];
  const paths = [];
  for (const e of excludes ?? []) {
    if (e.startsWith("/")) paths.push(comparable(e.slice(1)));
    else names.push(compilePattern(e));
  }
  return { patterns: names, subPaths: paths };
}

export function createTracker(db, onChange) {
  let folders = []; // [{ id, name, path, excludes, patterns }]

  // The backup folder an absolute path is in (or null)
  function folderFor(absPath) {
    for (const f of folders) {
      const rel = path.relative(f.path, absPath);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return f;
    }
    return null;
  }

  // Database paths always use "/" so they're the same on Windows and Linux
  function toRel(absPath) {
    const f = folderFor(absPath);
    if (!f) return null;
    const inner = path.relative(f.path, absPath).split(path.sep).join("/");
    return inner ? `${f.name}/${inner}` : f.name;
  }

  function toAbs(relPath) {
    const [name, ...rest] = relPath.split("/");
    const f = folders.find((x) => x.name === name);
    return f ? path.join(f.path, ...rest) : null;
  }

  // Built-in rules (temp files, recycle bins...) plus the folder's own exclusion patterns
  function isExcluded(absPath) {
    if (isIgnored(absPath)) return true;
    const f = folderFor(absPath);
    if (!f || (f.patterns.length === 0 && f.subPaths.length === 0)) return false;
    const parts = path.relative(f.path, absPath).split(path.sep).filter(Boolean);
    if (f.subPaths.length) {
      const rel = comparable(parts.join("/"));
      if (f.subPaths.some((sp) => rel === sp || rel.startsWith(`${sp}/`))) return true;
    }
    return parts.some((part) => f.patterns.some((re) => re.test(part)));
  }

  function report(type, relPath, size, sha256) {
    db.recordChange(type, relPath, size, sha256);
    onChange({ type, relPath, size, sha256 });
  }

  // Look at one file on disk and compare it to what the database knows.
  async function checkFile(absPath, stats) {
    const relPath = toRel(absPath);
    if (!relPath) return;
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

  // Walk a folder and check every file in it, adding each file seen to `seen`.
  async function scanDir(absDir, seen) {
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      log.warn(`Could not read folder ${absDir}: ${err.code || err.message}`);
      return false;
    }
    for (const entry of entries) {
      const absPath = path.join(absDir, entry.name);
      if (isExcluded(absPath)) continue;
      if (entry.isSymbolicLink()) continue; // never follow links out of the backup folder
      if (entry.isDirectory()) {
        await scanDir(absPath, seen);
      } else if (entry.isFile()) {
        seen?.add(toRel(absPath));
        try {
          await checkFile(absPath, await fs.stat(absPath));
        } catch (err) {
          if (err.code !== "ENOENT") log.warn(`Could not check ${absPath}: ${err.message}`);
        }
      }
    }
    return true;
  }

  // Scan one backup folder completely: new, changed and deleted files
  async function scanFolder(folder) {
    const seen = new Set();
    // If the folder itself can't be read (drive unplugged, permissions), don't treat
    // everything in it as deleted
    if (!(await scanDir(folder.path, seen))) return;
    const missing = db.filesUnder(folder.name).filter((p) => !seen.has(p));
    for (const p of missing) markGone(p);
  }

  return {
    // The folders to back up (already checked by the folder manager)
    setFolders(list) {
      folders = list.map((f) => ({ ...f, ...splitExcludes(f.excludes) }));
    },
    folders: () => folders,
    folderByName: (name) => folders.find((f) => f.name === name) ?? null,

    // Called for every watcher hint. Works out what actually happened.
    async inspect(absPath) {
      if (!folderFor(absPath) || isExcluded(absPath)) return;
      const relPath = toRel(absPath);
      let stats;
      try {
        stats = await fs.lstat(absPath);
      } catch (err) {
        if (err.code === "ENOENT") {
          // The backup folder itself vanished (unplugged drive, renamed): wait for the next scan
          if (!relPath.includes("/")) return;
          return markGone(relPath);
        }
        throw err;
      }
      if (stats.isSymbolicLink()) return;
      if (stats.isDirectory()) return scanDir(absPath); // e.g. a folder moved in
      if (stats.isFile()) return checkFile(absPath, stats);
    },

    // Full scan: catches everything that changed while the agent was off
    async fullScan() {
      for (const f of folders) await scanFolder(f);
    },
    scanFolder: (name) => {
      const f = folders.find((x) => x.name === name);
      return f ? scanFolder(f) : null;
    },

    isExcluded,
    toAbs,
  };
}
