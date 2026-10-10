// Manages the backup folders on this device.
//
// - The gateway decides WHICH folders to back up (you choose them in the web UI).
// - This device decides WHERE that's allowed: only inside the allowed areas (AGENT_ALLOWED_PATHS).
//   A folder outside them is refused, and the folder browser can't look outside them either.
// - The last folder list received is kept in the local database, so backups keep running offline.
// - Removing a folder makes the agent forget its files WITHOUT reporting them as deleted, so
//   the gateway keeps every backup of them.

import fs from "node:fs/promises";
import path from "node:path";
import { open, seal } from "./crypto-box.js";
import { isIgnored } from "./ignore.js";
import { log } from "./logger.js";

const MAX_BROWSE_ENTRIES = 1000;

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// Same naming rule as the gateway: "C:\Users\Anna\Documents" -> "Documents"
function folderNameFromPath(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (/^[A-Za-z]:$/.test(last)) return `Drive ${last[0].toUpperCase()}`;
  return (last || "Root").slice(0, 64);
}

export function createFolderManager({ config, db, tracker, watcher, enqueue }) {
  let states = new Map(); // folder name -> { state, error }
  let connection = null;
  let synced = false;
  let syncing = null;
  const onFirstSync = [];

  // Is this folder allowed and usable on this device? Returns { state, error }.
  async function check(folder, accepted) {
    if (!path.isAbsolute(folder.path)) return { state: "denied", error: "Not a full path on this device" };
    let real;
    try {
      real = await fs.realpath(folder.path);
      if (!(await fs.stat(real)).isDirectory()) return { state: "missing", error: "This is a file, not a folder" };
    } catch {
      return { state: "missing", error: "The folder doesn't exist on the device (deleted, renamed or drive unplugged)" };
    }
    if (!config.allowedPaths.some((a) => isInside(real, a))) {
      return { state: "denied", error: "Outside the allowed areas set on this device (AGENT_ALLOWED_PATHS)" };
    }
    if (isInside(config.dataDir, real) || isInside(real, config.dataDir)) {
      return { state: "denied", error: "Contains the agent's own data folder" };
    }
    const clash = accepted.find((a) => isInside(real, a.real) || isInside(a.real, real));
    if (clash) return { state: "denied", error: `Overlaps the folder "${clash.name}"` };
    return { state: "ok", real };
  }

  // Check every folder, then point the tracker and watcher at the usable ones.
  // Folders that just became usable get a full scan.
  async function activate() {
    const before = new Set(tracker.folders().map((f) => `${f.name}\n${f.path}`));
    const accepted = [];
    const next = new Map();
    for (const f of db.listFolders()) {
      const result = await check(f, accepted);
      next.set(f.name, { state: result.state, error: result.error ?? null });
      if (result.state === "ok") accepted.push({ ...f, path: result.real, real: result.real });
      else log.warn(`Folder "${f.name}" (${f.path}) is not being backed up: ${result.error}`);
    }
    states = next;
    tracker.setFolders(accepted);
    watcher.setPaths(accepted.map((f) => f.path));

    for (const f of accepted) {
      if (before.has(`${f.name}\n${f.path}`)) continue;
      log.info(`Backing up folder "${f.name}" → ${f.path}`);
      enqueue(async () => {
        const started = Date.now();
        await tracker.scanFolder(f.name);
        log.info(`Scanned "${f.name}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        connection?.heartbeatNow(); // so the web UI shows the new file counts straight away
      });
    }
    if (accepted.length === 0) log.info("No backup folders yet. Add one from the gateway's web UI.");
  }

  // Apply the folder list from the gateway. Folders are matched by NAME, which never changes.
  async function applyWanted(wanted) {
    const current = new Map(db.listFolders().map((f) => [f.name, f]));
    const next = new Map(wanted.map((f) => [f.name, f]));

    for (const [name, old] of current) {
      const now = next.get(name);
      if (!now || now.path !== old.path) {
        const { forgotten, skipped } = db.forgetFolder(name);
        log.info(`Stopped backing up folder "${name}" (${forgotten} file(s) forgotten locally; their backups are kept on the gateway${skipped ? `, ${skipped} unsent change(s) dropped` : ""})`);
      }
    }
    db.replaceFolders(wanted);

    // Excluded files are forgotten too (not reported as deleted)
    await activate();
    for (const f of tracker.folders()) {
      const old = current.get(f.name);
      if (!old || JSON.stringify(old.excludes) === JSON.stringify(f.excludes)) continue;
      let dropped = 0;
      for (const rel of db.filesUnder(f.name)) {
        const abs = tracker.toAbs(rel);
        if (abs && tracker.isExcluded(abs)) {
          db.removeFile(rel);
          dropped++;
        }
      }
      log.info(`Exclusions changed for "${f.name}": ${f.excludes.join(", ") || "none"}${dropped ? ` (${dropped} file(s) no longer backed up)` : ""}`);
      // Picks up files that are no longer excluded
      enqueue(async () => {
        await tracker.scanFolder(f.name);
        connection?.heartbeatNow();
      });
    }
  }

  // Per-folder status for the gateway (no paths, just numbers)
  function report() {
    return db.listFolders().map((f) => {
      const s = states.get(f.name) ?? { state: "missing", error: null };
      const stats = s.state === "ok" ? db.folderStats(f.name) : { files: null, bytes: null };
      return { id: f.id, state: s.state, error: s.error, files: stats.files, bytes: stats.bytes };
    });
  }

  async function doSync() {
    const keys = await connection.ensureKeys();
    const { deviceId } = connection.auth;
    const legacyFolder = db.getSetting("legacyFolder");
    const body = {
      platform: process.platform,
      allowedPaths: config.allowedPaths,
      folders: report(),
      ...(legacyFolder ? { legacyFolder } : {}),
    };
    const box = await connection.client.signedPostBinary(
      "/api/folders/sync",
      seal(keys.encKey, Buffer.from(JSON.stringify(body)), `folders-report:${deviceId}`),
      connection.auth
    );
    const wanted = JSON.parse(open(keys.encKey, box, `folders:${deviceId}`).toString("utf8"));
    if (legacyFolder) db.deleteSetting("legacyFolder"); // the gateway has it now

    if (db.getSetting("foldersVersion") !== wanted.version || !synced) {
      await applyWanted(wanted.folders);
      db.setSetting("foldersVersion", wanted.version);
    }
    if (!synced) {
      synced = true;
      onFirstSync.splice(0).forEach((fn) => fn());
    }
  }

  return {
    // Load the folders saved locally and start backing them up (works without the gateway)
    async init() {
      // Upgrade from the single-folder version: AGENT_WATCH_DIR becomes the first folder,
      // and every path the agent already knows moves under that folder's name.
      if (db.getSetting("layout") !== 2) {
        if (config.watchDir) {
          const name = folderNameFromPath(config.watchDir);
          db.prefixAllPaths(name);
          db.replaceFolders([{ id: "local", name, path: config.watchDir, excludes: [] }]);
          db.setSetting("legacyFolder", { name, path: config.watchDir });
          log.info(`Backup folder "${name}" set up from AGENT_WATCH_DIR. From now on, manage folders in the web UI.`);
        }
        db.setSetting("layout", 2);
      } else if (config.watchDir && !db.listFolders().some((f) => f.path === config.watchDir)) {
        log.info("AGENT_WATCH_DIR is only used the first time. Manage backup folders in the web UI.");
      }
      await activate();
    },

    // Connect to the gateway: get the folder list now, and again whenever it changes
    attach(conn) {
      connection = conn;
    },
    sync() {
      if (!connection) return Promise.resolve();
      syncing ??= doSync()
        .catch((err) => {
          if (err.status) log.error(`Folder sync failed: ${err.message}`);
          else if (err.security) log.error(err.message);
          else log.debug(`Folder sync postponed: ${err.message}`);
        })
        .finally(() => (syncing = null));
      return syncing;
    },
    // The gateway's folder list version, from each heartbeat
    checkVersion(version) {
      if (!synced || db.getSetting("foldersVersion") !== version) this.sync();
    },
    isSynced: () => synced,
    whenSynced: (fn) => (synced ? fn() : onFirstSync.push(fn)),
    report,

    // The live folder browser: list the sub-folders (names only) of a folder in the allowed areas
    async browse(requested) {
      const backedUp = (real) => db.listFolders().find((f) => states.get(f.name)?.state === "ok" && tracker.folderByName(f.name)?.path === real);
      const insideFolder = (real) => tracker.folders().find((f) => isInside(real, f.path));

      if (!requested) {
        return {
          path: "",
          parent: null,
          separator: path.sep,
          entries: config.allowedPaths.map((a) => ({ name: a, path: a, backedUpAs: backedUp(a)?.name ?? null })),
        };
      }
      if (!path.isAbsolute(requested)) return { error: "Not a full path on this device" };
      let real;
      try {
        real = await fs.realpath(requested);
      } catch {
        return { error: "That folder doesn't exist on the device" };
      }
      if (!config.allowedPaths.some((a) => isInside(real, a))) {
        return { error: "That folder is outside the allowed areas set on this device" };
      }

      let entries;
      try {
        entries = await fs.readdir(real, { withFileTypes: true });
      } catch (err) {
        return { error: `The device can't open that folder (${err.code || err.message})` };
      }
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !isIgnored(path.join(real, e.name)) && !isInside(path.join(real, e.name), config.dataDir))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

      const isRoot = config.allowedPaths.includes(real);
      return {
        path: real,
        parent: isRoot ? "" : path.dirname(real),
        separator: path.sep,
        backedUpAs: backedUp(real)?.name ?? null,
        insideFolder: insideFolder(real)?.name ?? null,
        truncated: dirs.length > MAX_BROWSE_ENTRIES,
        entries: dirs.slice(0, MAX_BROWSE_ENTRIES).map((name) => {
          const full = path.join(real, name);
          return { name, path: full, backedUpAs: backedUp(full)?.name ?? null };
        }),
      };
    },

    // Answer a browse request from the gateway (sealed so only the gateway can read it)
    async answerBrowse(request) {
      try {
        const result = await this.browse(request.path);
        const keys = await connection.ensureKeys();
        const box = seal(keys.encKey, Buffer.from(JSON.stringify({ id: request.id, ...result })), `browse-result:${connection.auth.deviceId}`);
        await connection.client.signedPostBinary("/api/browse/result", box, connection.auth);
        log.debug(`Folder browser: listed ${request.path || "allowed areas"}`);
      } catch (err) {
        log.warn(`Could not answer a folder-browse request: ${err.message}`);
      }
    },
  };
}
