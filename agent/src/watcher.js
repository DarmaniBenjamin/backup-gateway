// Watches the backup folders and reports paths that may have changed.
// It does NOT decide what changed — the tracker checks the disk and database for that.
// Folders can be added and removed while running (when they're changed in the web UI).

import chokidar from "chokidar";
import { log } from "./logger.js";

// onLimit is called once if the operating system can't watch this many folders
// (Linux / Synology "inotify" limit); the agent then switches to scheduled scans.
export function startWatcher(isExcluded, onHint, onLimit) {
  const watched = new Set();
  const watcher = chokidar.watch([], {
    ignored: (p) => isExcluded(p),
    ignoreInitial: true,        // the full scan handles existing files
    persistent: true,
    followSymlinks: false,      // never follow links out of the backup folder
    awaitWriteFinish: {
      stabilityThreshold: 2000, // file size must be stable for 2 s before we look at it
      pollInterval: 250,
    },
  });

  for (const event of ["add", "change", "unlink", "addDir", "unlinkDir"]) {
    watcher.on(event, (p) => onHint(p));
  }
  let limitHit = false;
  watcher.on("error", (err) => {
    if (err?.code === "ENOSPC" || err?.code === "EMFILE") {
      if (!limitHit) {
        limitHit = true;
        onLimit?.(err);
      }
      return;
    }
    log.error("Watcher error", err);
  });

  return {
    // Watch exactly these folders
    setPaths(paths) {
      const wanted = new Set(paths);
      for (const p of watched) {
        if (!wanted.has(p)) {
          watcher.unwatch(p);
          watched.delete(p);
        }
      }
      for (const p of wanted) {
        if (!watched.has(p)) {
          watcher.add(p);
          watched.add(p);
        }
      }
    },
    close: () => watcher.close(),
  };
}
