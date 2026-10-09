// Watches a folder and reports paths that may have changed.
// It does NOT decide what changed — the tracker checks the disk and database for that.

import chokidar from "chokidar";
import { isIgnored } from "./ignore.js";
import { log } from "./logger.js";

export function startWatcher(rootDir, onHint) {
  const watcher = chokidar.watch(rootDir, {
    ignored: (p) => isIgnored(p),
    ignoreInitial: true,        // the startup full scan handles existing files
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
  watcher
    .on("ready", () => log.info(`Watching ${rootDir} for changes`))
    .on("error", (err) => log.error("Watcher error", err));

  return watcher;
}