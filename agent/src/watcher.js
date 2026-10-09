// Watches a folder and reports file changes.
// Ignores temp/junk files and waits until files finish writing.

import path from "node:path";
import chokidar from "chokidar";
import { log } from "./logger.js";

// Names we never back up (matched against each part of the path)
const IGNORED_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "@eaDir",        // Synology thumbnails/metadata
  "#recycle",      // Synology recycle bin
  "#snapshot",     // Synology snapshots
  "$RECYCLE.BIN",  // Windows recycle bin
  "System Volume Information",
  "node_modules",
]);

function isIgnored(filePath) {
  const parts = filePath.split(path.sep);
  for (const part of parts) {
    if (IGNORED_NAMES.has(part)) return true;
  }
  const name = path.basename(filePath);
  if (name.startsWith("~$")) return true;                    // Office lock/temp files
  if (name.startsWith(".~lock.")) return true;               // LibreOffice lock files
  if (/\.(tmp|temp|part|crdownload|swp)$/i.test(name)) return true; // temp/partial downloads
  return false;
}

/**
 * Starts watching `rootDir`. Calls onChange({ type, path, relativePath, size }) for each change.
 * type is one of: "added", "changed", "deleted", "folder-added", "folder-deleted"
 */
export function startWatcher(rootDir, onChange) {
  const watcher = chokidar.watch(rootDir, {
    ignored: (p) => isIgnored(p),
    ignoreInitial: true,        // don't report files that already exist (handled by a full scan later)
    persistent: true,
    followSymlinks: false,      // never follow links out of the backup folder
    alwaysStat: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000, // file size must be stable for 2 s before we report it
      pollInterval: 250,
    },
  });

  const emit = (type, filePath, stats) => {
    onChange({
      type,
      path: filePath,
      relativePath: path.relative(rootDir, filePath),
      size: stats?.size ?? null,
      at: new Date().toISOString(),
    });
  };

  watcher
    .on("add", (p, stats) => emit("added", p, stats))
    .on("change", (p, stats) => emit("changed", p, stats))
    .on("unlink", (p) => emit("deleted", p))
    .on("addDir", (p) => emit("folder-added", p))
    .on("unlinkDir", (p) => emit("folder-deleted", p))
    .on("ready", () => log.info(`Watching ${rootDir}`))
    .on("error", (err) => log.error("Watcher error", err));

  return watcher;
}