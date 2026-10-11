// Off-site copies. Each one is a "destination":
//
//   the failsafe   one place that gets EVERYTHING from every device (a Backblaze/S3 bucket or a
//                  Google Drive). "Back up everything now" pushes it straight away.
//   device copies  any number per device: that device's own Backblaze bucket (with its own key)
//                  and/or its own Google Drive. Each backup folder on the device's page picks
//                  which of them it goes to (see routing.js).
//
// Every copy only gets data that's already encrypted on the gateway, plus a catalog (the database
// and keys needed to rebuild, encrypted to the recovery key). A device's own copy gets a catalog
// with only that device in it. One recovery key opens every copy.
//
// Backblaze/S3: one object per chunk, each locked with Object Lock; locks of chunks still in use
// are extended before they run out (see offsite.js). Google Drive: chunks packed ~16 MB per file;
// no locks exist there, so keep a Backblaze copy for that (see gdrive.js).

import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createS3 } from "./s3.js";
import { PROVIDERS, explain, chunkKey, makeCatalog } from "./offsite.js";
import { createDrive, explainDrive } from "./gdrive.js";
import { createRecoveryKey, sealForRecovery } from "./recovery.js";
import { routerFor } from "./routing.js";
import { log } from "../logger.js";

const DAY = 24 * 3600 * 1000;
const PASS_EVERY_MS = 60_000;
const FULL_SCAN_EVERY_MS = 6 * 3600 * 1000;
const CATALOG_EVERY_MS = DAY;
const CATALOG_MIN_GAP_MS = 15 * 60 * 1000;
const UPLOADS_AT_ONCE = 4;
const PACK_BYTES = 16 * 1024 * 1024;
const PACK_MAX_CHUNKS = 4096;

export class CopyError extends Error {}

export function createCopies({ db, dataDir, storage, security = null }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS offsite_destinations (
      id           TEXT PRIMARY KEY,           -- "failsafe", or a random id for a device's copy
      kind         TEXT NOT NULL CHECK (kind IN ('s3', 'drive')),
      device_id    TEXT,                       -- NULL = the failsafe (every device)
      settings     TEXT NOT NULL,              -- JSON: bucket and key, or Google sign-in and folders
      paused       INTEGER NOT NULL DEFAULT 0,
      connected_at TEXT NOT NULL,
      connected_by TEXT
    );
    -- What's in each copy. S3: locked_until. Google Drive: which pack file, and where in it.
    CREATE TABLE IF NOT EXISTS offsite_objects (
      dest_id      TEXT NOT NULL,
      device_id    TEXT NOT NULL,
      chunk_id     TEXT NOT NULL,
      size         INTEGER NOT NULL,
      uploaded_at  TEXT NOT NULL,
      locked_until TEXT,
      pack         TEXT,
      pack_offset  INTEGER,
      PRIMARY KEY (dest_id, device_id, chunk_id)
    );
    CREATE INDEX IF NOT EXISTS idx_offsite_objects_lock ON offsite_objects (dest_id, locked_until);
    CREATE TABLE IF NOT EXISTS offsite_packs (
      dest_id     TEXT NOT NULL,
      name        TEXT NOT NULL,
      file_id     TEXT NOT NULL,
      size        INTEGER NOT NULL,
      chunks      INTEGER NOT NULL,
      uploaded_at TEXT NOT NULL,
      PRIMARY KEY (dest_id, name)
    );
    CREATE TABLE IF NOT EXISTS offsite_catalogs (
      dest_id      TEXT NOT NULL,
      key          TEXT NOT NULL,
      size         INTEGER NOT NULL,
      created_at   TEXT NOT NULL,
      locked_until TEXT,
      PRIMARY KEY (dest_id, key)
    );
    CREATE TABLE IF NOT EXISTS offsite_drive_folders (
      dest_id TEXT NOT NULL,
      name    TEXT NOT NULL,
      id      TEXT NOT NULL,
      PRIMARY KEY (dest_id, name)
    );
    CREATE TABLE IF NOT EXISTS cloud_meta (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const q = {
    all: conn.prepare("SELECT * FROM offsite_destinations ORDER BY device_id IS NOT NULL, connected_at"),
    get: conn.prepare("SELECT * FROM offsite_destinations WHERE id = ?"),
    add: conn.prepare("INSERT INTO offsite_destinations (id, kind, device_id, settings, paused, connected_at, connected_by) VALUES (?, ?, ?, ?, 0, ?, ?)"),
    setSettings: conn.prepare("UPDATE offsite_destinations SET settings = ? WHERE id = ?"),
    setPaused: conn.prepare("UPDATE offsite_destinations SET paused = ? WHERE id = ?"),
    remove: conn.prepare("DELETE FROM offsite_destinations WHERE id = ?"),
    okAllSince: conn.prepare(
      "SELECT id, device_id, rel_path, chunk_ids FROM file_versions WHERE status = 'ok' AND chunk_ids IS NOT NULL AND COALESCE(scan_status, '') <> 'pending' AND id > ? ORDER BY id"
    ),
    okDeviceSince: conn.prepare(
      "SELECT id, device_id, rel_path, chunk_ids FROM file_versions WHERE device_id = ? AND status = 'ok' AND chunk_ids IS NOT NULL AND COALESCE(scan_status, '') <> 'pending' AND id > ? ORDER BY id"
    ),
    isUploaded: conn.prepare("SELECT 1 FROM offsite_objects WHERE dest_id = ? AND device_id = ? AND chunk_id = ?"),
    boxSize: conn.prepare("SELECT box_size FROM chunks WHERE device_id = ? AND chunk_id = ?"),
    addObject: conn.prepare(`
      INSERT OR REPLACE INTO offsite_objects (dest_id, device_id, chunk_id, size, uploaded_at, locked_until, pack, pack_offset)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    expiring: conn.prepare(
      "SELECT device_id, chunk_id FROM offsite_objects WHERE dest_id = ? AND locked_until < ? ORDER BY locked_until LIMIT 5000"
    ),
    setLock: conn.prepare("UPDATE offsite_objects SET locked_until = ? WHERE dest_id = ? AND device_id = ? AND chunk_id = ?"),
    totals: conn.prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes, MIN(locked_until) AS soonest FROM offsite_objects WHERE dest_id = ?"
    ),
    addPack: conn.prepare("INSERT INTO offsite_packs (dest_id, name, file_id, size, chunks, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)"),
    addCatalog: conn.prepare("INSERT INTO offsite_catalogs (dest_id, key, size, created_at, locked_until) VALUES (?, ?, ?, ?, ?)"),
    lastCatalog: conn.prepare("SELECT * FROM offsite_catalogs WHERE dest_id = ? ORDER BY created_at DESC LIMIT 1"),
    getFolder: conn.prepare("SELECT id FROM offsite_drive_folders WHERE dest_id = ? AND name = ?"),
    setFolder: conn.prepare("INSERT OR REPLACE INTO offsite_drive_folders (dest_id, name, id) VALUES (?, ?, ?)"),
    forget: [
      conn.prepare("DELETE FROM offsite_objects WHERE dest_id = ?"),
      conn.prepare("DELETE FROM offsite_packs WHERE dest_id = ?"),
      conn.prepare("DELETE FROM offsite_catalogs WHERE dest_id = ?"),
      conn.prepare("DELETE FROM offsite_drive_folders WHERE dest_id = ?"),
    ],
    getMeta: conn.prepare("SELECT value FROM cloud_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO cloud_meta (name, value) VALUES (?, ?)"),
    openAlert: conn.prepare("SELECT id FROM alerts WHERE kind = 'cloud' AND acknowledged_at IS NULL AND message LIKE ? LIMIT 1"),
    device: conn.prepare("SELECT id, client_name, device_name FROM devices WHERE id = ?"),
  };

  function tx(fn) {
    conn.exec("BEGIN");
    try {
      const r = fn();
      conn.exec("COMMIT");
      return r;
    } catch (err) {
      conn.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- The one recovery key for every copy ----------------------------------------------------

  const meta = (name) => q.getMeta.get(name)?.value ?? null;
  function recovery() {
    const publicKey = meta("recovery_public");
    return publicKey ? { publicKey, fingerprint: meta("recovery_fp") } : null;
  }
  // Made the first time any copy is connected. Returns the key text ONCE (or null if it existed).
  function ensureRecovery() {
    if (recovery()) return null;
    const r = createRecoveryKey();
    q.setMeta.run("recovery_public", r.publicKey);
    q.setMeta.run("recovery_fp", r.fingerprint);
    return { recoveryKey: r.recoveryKey, fingerprint: r.fingerprint };
  }

  // ---- Upgrade from the single off-site connection: it becomes the failsafe -------------------

  const hasOldConfig = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cloud_config'").get();
  if (hasOldConfig) {
    const old = conn.prepare("SELECT * FROM cloud_config WHERE id = 1").get();
    if (old && !q.get.get("failsafe")) {
      tx(() => {
        if (!recovery()) {
          q.setMeta.run("recovery_public", old.recovery_public);
          q.setMeta.run("recovery_fp", old.recovery_fp);
        }
        const settings = {
          provider: old.provider, endpoint: old.endpoint, region: old.region, bucket: old.bucket,
          keyId: old.key_id, secret: old.secret, lockMode: old.lock_mode, retentionDays: old.retention_days,
        };
        q.add.run("failsafe", "s3", null, JSON.stringify(settings), old.connected_at, old.connected_by);
        q.setPaused.run(old.paused, "failsafe");
        conn.exec(`
          INSERT OR IGNORE INTO offsite_objects (dest_id, device_id, chunk_id, size, uploaded_at, locked_until)
            SELECT 'failsafe', device_id, chunk_id, size, uploaded_at, locked_until FROM cloud_objects;
          INSERT OR IGNORE INTO offsite_catalogs (dest_id, key, size, created_at, locked_until)
            SELECT 'failsafe', key, size, created_at, locked_until FROM cloud_catalogs;
          DELETE FROM cloud_config; -- the key now lives in one place only
        `);
      });
      log.info("Off-site: the Backblaze/S3 connection is now the failsafe copy (everything from every device)");
    }
  }

  // ---- Runtime state per destination ----------------------------------------------------------

  const states = new Map();
  const stateOf = (id) => {
    if (!states.has(id)) {
      states.set(id, {
        running: false, cursor: 0, lastFullScan: 0, pending: null, lastPassAt: null, lastSuccessAt: null,
        lastError: null, failingSince: null, failures: 0, nextPassAt: Date.now() + 5000, uploadedSinceCatalog: 0, current: null,
      });
    }
    return states.get(id);
  };
  const parse = (d) => (d ? { ...d, settings: JSON.parse(d.settings) } : null);
  const list = () => q.all.all().map(parse);
  const getDest = (id) => parse(q.get.get(id));
  const isFailsafe = (d) => !d.device_id;

  function forgetUploads(destId) {
    tx(() => q.forget.forEach((s) => s.run(destId)));
    Object.assign(stateOf(destId), { cursor: 0, lastFullScan: 0, uploadedSinceCatalog: 1 });
  }

  // What this copy is still missing: chunks of "ok" versions it should have
  function scan(d, fromId) {
    const want = new Map();
    const referenced = fromId === 0 ? new Set() : null;
    let maxId = fromId;
    const routed = routerFor(conn, d);
    const rows = d.device_id ? q.okDeviceSince.iterate(d.device_id, fromId) : q.okAllSince.iterate(fromId);
    for (const v of rows) {
      maxId = v.id;
      if (!routed(v.device_id, v.rel_path)) continue;
      for (const id of JSON.parse(v.chunk_ids)) {
        const k = `${v.device_id} ${id}`;
        referenced?.add(k);
        if (!want.has(k) && !q.isUploaded.get(d.id, v.device_id, id)) want.set(k, [v.device_id, id]);
      }
    }
    return { todo: [...want.values()], maxId, referenced };
  }

  function readBox(deviceId, chunkId) {
    try {
      return storage.readChunk(deviceId, chunkId);
    } catch {
      log.warn(`Off-site: chunk ${chunkId.slice(0, 12)}… of ${deviceId} is missing on the gateway; run an integrity check`);
      return null;
    }
  }

  const catalogFor = (d) => sealForRecovery(recovery().publicKey, makeCatalog(conn, dataDir, { deviceId: d.device_id, destId: d.id }));

  // ---- Backblaze / S3 ------------------------------------------------------------------------

  const s3Driver = {
    explain,
    open: (d) => createS3({ endpoint: d.settings.endpoint, region: d.settings.region, bucket: d.settings.bucket, accessKeyId: d.settings.keyId, secretAccessKey: d.settings.secret }),
    prepare: async (d) => d,

    async upload(d, s3, todo, st) {
      let i = 0;
      let done = 0;
      async function worker() {
        while (i < todo.length) {
          const [deviceId, chunkId] = todo[i++];
          const box = readBox(deviceId, chunkId);
          if (!box) continue;
          const until = new Date(Date.now() + d.settings.retentionDays * DAY);
          await s3.putObject(chunkKey(deviceId, chunkId), box, { lockMode: d.settings.lockMode, lockUntil: until });
          q.addObject.run(d.id, deviceId, chunkId, box.length, new Date().toISOString(), until.toISOString(), null, null);
          st.current.done = ++done;
        }
      }
      await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, todo.length) }, worker));
      return done;
    },

    // Keep chunks that are still part of a backup locked: extend locks that run out soon
    async renew(d, s3, referenced, st) {
      const days = d.settings.retentionDays;
      const renewBefore = Math.max(2, Math.ceil(days / 4)) * DAY;
      const rows = q.expiring.all(d.id, new Date(Date.now() + renewBefore).toISOString()).filter((r) => referenced.has(`${r.device_id} ${r.chunk_id}`));
      if (!rows.length) return;
      st.current = { action: "Extending locks", done: 0, total: rows.length };
      for (const r of rows) {
        const until = new Date(Date.now() + days * DAY);
        await s3.extendLock(chunkKey(r.device_id, r.chunk_id), d.settings.lockMode, until);
        q.setLock.run(until.toISOString(), d.id, r.device_id, r.chunk_id);
        st.current.done++;
      }
      log.info(`Off-site (${label(d)}): kept ${rows.length} chunk(s) locked for another ${days} day(s)`);
    },

    async catalog(d, s3) {
      const box = catalogFor(d);
      const now = new Date();
      const key = `catalog/${now.toISOString().slice(0, 7)}/${now.toISOString()}.bin`;
      // Catalogs stay locked a little longer than chunks, so a locked one always exists
      const until = new Date(Date.now() + (d.settings.retentionDays + 2) * DAY);
      await s3.putObject(key, box, { lockMode: d.settings.lockMode, lockUntil: until });
      q.addCatalog.run(d.id, key, box.length, now.toISOString(), until.toISOString());
      return box.length;
    },
  };

  // ---- Google Drive ---------------------------------------------------------------------------

  // The name a new folder gets unless the person types another
  function defaultFolderName(deviceId) {
    const who = deviceId ? q.device.get(deviceId) : null;
    return who ? `Backup Gateway - ${who.client_name} - ${who.device_name}` : "Backup Gateway - failsafe (all devices)";
  }

  // The copy's folder in Drive, and its "packs" and "catalogs" folders inside. place is one of:
  //   { folderId }        a folder the person picked (one already in the Drive)
  //   { name, parentId }  a new folder, in My Drive or inside a picked folder
  // The gateway's own sub-folders are reused if they're already there (the same folder chosen again).
  async function driveFolders(drive, place) {
    let root;
    let folderName;
    if (place.folderId) {
      ({ id: root, name: folderName } = await drive.folder(place.folderId));
    } else {
      if (place.parentId) await drive.folder(place.parentId); // still there, and a folder
      folderName = place.name;
      root = await drive.createFolder(place.name, place.parentId ?? null, { backupGateway: "root" });
    }
    const sub = async (kind) => (place.folderId && (await drive.findChild(root, kind))) || drive.createFolder(kind, root, { backupGateway: kind });
    return { rootId: root, folderName, packsId: await sub("packs"), catalogsId: await sub("catalogs") };
  }

  const driveDriver = {
    explain: explainDrive,
    open: (d) => createDrive({ clientId: d.settings.clientId, clientSecret: d.settings.clientSecret, refreshToken: d.settings.refreshToken }),

    // Someone deleted the copy's folder (or put it in the bin): start again in a new one
    async prepare(d, drive, full) {
      if (!full || (await drive.exists(d.settings.rootId))) return d;
      log.warn(`Off-site (${label(d)}): its folder is gone from Google Drive. Uploading everything again into a new folder.`);
      raise(d, "Its folder on Google Drive was deleted or moved to the bin. Everything is being uploaded again.");
      const folders = await driveFolders(drive, { name: d.settings.folderName || defaultFolderName(d.device_id) });
      forgetUploads(d.id);
      q.setSettings.run(JSON.stringify({ ...d.settings, ...folders }), d.id);
      return getDest(d.id);
    },

    async upload(d, drive, todo, st) {
      let entries = [];
      let parts = [];
      let size = 0;
      let done = 0;
      const flush = async () => {
        const month = new Date().toISOString().slice(0, 7);
        let folder = q.getFolder.get(d.id, month)?.id;
        if (!folder) {
          folder = await drive.createFolder(month, d.settings.packsId, { backupGateway: "month" });
          q.setFolder.run(d.id, month, folder);
        }
        const name = `pack-${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(4).toString("hex")}.bin`;
        const fileId = await drive.upload(name, folder, Buffer.concat(parts, size), { backupGateway: "pack" });
        const now = new Date().toISOString();
        tx(() => {
          for (const e of entries) q.addObject.run(d.id, e.deviceId, e.chunkId, e.length, now, null, name, e.offset);
          q.addPack.run(d.id, name, fileId, size, entries.length, now);
        });
        done += entries.length;
        st.current.done = done;
        entries = [];
        parts = [];
        size = 0;
      };
      for (const [deviceId, chunkId] of todo) {
        const box = readBox(deviceId, chunkId);
        if (!box) continue;
        entries.push({ deviceId, chunkId, offset: size, length: box.length });
        parts.push(box);
        size += box.length;
        if (size >= PACK_BYTES || entries.length >= PACK_MAX_CHUNKS) await flush();
      }
      if (entries.length) await flush();
      return done;
    },

    async renew() {}, // Google Drive has no locks

    async catalog(d, drive) {
      const box = catalogFor(d);
      const now = new Date();
      const name = `catalog-${now.toISOString().replace(/[:.]/g, "-")}.bin`;
      await drive.upload(name, d.settings.catalogsId, box, { backupGateway: "catalog" });
      q.addCatalog.run(d.id, name, box.length, now.toISOString(), null);
      return box.length;
    },
  };

  const DRIVERS = { s3: s3Driver, drive: driveDriver };

  async function testDrive(drive, folderId) {
    const body = Buffer.from("Connection test from the backup gateway. Safe to delete.\n");
    const id = await drive.upload(`gateway-check-${Date.now()}.txt`, folderId, body, { backupGateway: "check" });
    const back = await drive.download(id);
    await drive.remove(id).catch(() => {});
    if (!back.equals(body)) throw new Error("The test file came back from Google Drive different from what was sent.");
  }

  function label(d) {
    const who = d.device_id ? q.device.get(d.device_id)?.device_name ?? d.device_id : "failsafe";
    const where = d.kind === "s3" ? d.settings.bucket : `Google Drive ${d.settings.email ?? ""}`.trim();
    return `${who}: ${where}`;
  }

  function raise(d, message) {
    const text = `Off-site copy ${label(d)}: ${message}`;
    if (q.openAlert.get(`Off-site copy ${label(d)}:%`)) return;
    db.addAlert(d.device_id, "cloud", text);
    security?.event("high", "offsite.failing", text, { deviceId: d.device_id, detail: { copy: label(d), error: message } });
  }

  // ---- One pass of one copy -------------------------------------------------------------------

  async function pass(id, { full = false } = {}) {
    let d = getDest(id);
    const st = stateOf(id);
    if (!d || d.paused || st.running || !recovery()) return;
    st.running = true;
    st.lastPassAt = new Date().toISOString();
    const driver = DRIVERS[d.kind];
    try {
      const client = driver.open(d);
      const doFull = full || Date.now() - st.lastFullScan > FULL_SCAN_EVERY_MS;
      d = (await driver.prepare(d, client, doFull)) ?? d;
      const { todo, maxId, referenced } = scan(d, doFull ? 0 : st.cursor);
      st.pending = { chunks: todo.length, bytes: todo.reduce((sum, [dev, c]) => sum + (q.boxSize.get(dev, c)?.box_size ?? 0), 0) };
      st.current = { action: "Uploading", done: 0, total: todo.length };
      if (todo.length) log.info(`Off-site (${label(d)}): uploading ${todo.length} chunk(s)`);
      const sent = await driver.upload(d, client, todo, st);
      st.cursor = Math.max(st.cursor, maxId);
      st.pending = { chunks: 0, bytes: 0 };
      st.uploadedSinceCatalog += sent;
      if (sent) log.info(`Off-site (${label(d)}): ${sent} chunk(s) uploaded`);
      if (doFull) {
        await driver.renew(d, client, referenced, st);
        st.lastFullScan = Date.now();
      }
      const last = q.lastCatalog.get(d.id);
      const age = last ? Date.now() - new Date(last.created_at).getTime() : Infinity;
      if ((st.uploadedSinceCatalog > 0 && age > CATALOG_MIN_GAP_MS) || age > CATALOG_EVERY_MS) {
        st.current = { action: "Uploading the catalog" };
        const size = await driver.catalog(d, client);
        st.uploadedSinceCatalog = 0;
        log.info(`Off-site (${label(d)}): catalog uploaded (${(size / 1024).toFixed(0)} KB, encrypted to recovery key ${recovery().fingerprint})`);
      }
      Object.assign(st, { lastSuccessAt: new Date().toISOString(), lastError: null, failingSince: null, failures: 0, nextPassAt: Date.now() + PASS_EVERY_MS });
    } catch (err) {
      const message = driver.explain(err);
      st.lastError = { message, at: new Date().toISOString() };
      st.failingSince ??= Date.now();
      st.failures++;
      // Wait longer after each failure (1, 2, 4... up to 30 minutes) instead of hammering the service
      st.nextPassAt = Date.now() + Math.min(30 * 60_000, PASS_EVERY_MS * 2 ** (st.failures - 1));
      log.error(`Off-site (${label(d)}) failed: ${message}`);
      if (Date.now() - st.failingSince > 3600_000) raise(d, `failing for over an hour: ${message}`);
    } finally {
      st.running = false;
      st.current = null;
    }
  }

  let timer = null;
  function tick() {
    for (const d of list()) {
      const st = stateOf(d.id);
      if (!d.paused && !st.running && Date.now() >= st.nextPassAt) pass(d.id).catch(() => {});
    }
  }

  function status(d) {
    const st = stateOf(d.id);
    const totals = q.totals.get(d.id);
    const last = q.lastCatalog.get(d.id);
    const who = d.device_id ? q.device.get(d.device_id) : null;
    const s = d.settings;
    return {
      id: d.id,
      kind: d.kind,
      failsafe: isFailsafe(d),
      deviceId: d.device_id,
      deviceName: who?.device_name ?? null,
      client: who?.client_name ?? null,
      ...(d.kind === "s3"
        ? { providerLabel: PROVIDERS[s.provider]?.label ?? s.provider, endpoint: s.endpoint, bucket: s.bucket, keyId: s.keyId, lockMode: s.lockMode, retentionDays: s.retentionDays }
        : { email: s.email, folderName: s.folderName ?? null, folderId: s.rootId ?? null }),
      paused: !!d.paused,
      connectedAt: d.connected_at,
      connectedBy: d.connected_by,
      uploaded: { chunks: totals.n, bytes: totals.bytes, soonestUnlock: totals.soonest },
      pending: st.pending,
      lastCatalog: last ? { at: last.created_at, size: last.size, lockedUntil: last.locked_until } : null,
      running: st.running,
      current: st.current,
      lastPassAt: st.lastPassAt,
      lastSuccessAt: st.lastSuccessAt,
      lastError: st.lastError,
    };
  }

  function add(kind, deviceId, settings, admin) {
    if (!deviceId && q.get.get("failsafe")) throw new CopyError("There's already a failsafe copy. Disconnect it first to switch.");
    if (deviceId && !q.device.get(deviceId)) throw new CopyError("That device doesn't exist.");
    const shown = ensureRecovery();
    const id = deviceId ? `d${crypto.randomBytes(6).toString("hex")}` : "failsafe";
    // The failsafe back on the same bucket as before: what's there is still there, don't re-send it
    const target = kind === "s3" ? `s3 ${settings.endpoint}/${settings.bucket}` : `drive ${settings.rootId}`;
    const sameAsBefore = !deviceId && meta("failsafe_target") === target;
    tx(() => {
      if (!sameAsBefore) q.forget.forEach((s) => s.run(id));
      if (!deviceId) q.setMeta.run("failsafe_target", target);
      q.add.run(id, kind, deviceId, JSON.stringify(settings), new Date().toISOString(), admin);
    });
    Object.assign(stateOf(id), { cursor: 0, lastFullScan: 0, nextPassAt: Date.now() + 3000, failures: 0, lastError: null, failingSince: null, uploadedSinceCatalog: 1 });
    const d = getDest(id);
    log.info(`Off-site copy connected: ${label(d)} (recovery key ${recovery().fingerprint})`);
    return { id, fingerprint: recovery().fingerprint, recoveryKey: shown?.recoveryKey ?? null };
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

    recovery,
    list: () => list().map(status),
    get: (id) => {
      const d = getDest(id);
      return d ? status(d) : null;
    },
    forDevice: (deviceId) => list().filter((d) => d.device_id === deviceId).map(status),
    failsafe: () => {
      const d = getDest("failsafe");
      return d ? status(d) : null;
    },
    raw: getDest,

    // A tested Backblaze/S3 bucket. deviceId null = the failsafe.
    addS3(settings, deviceId, admin) {
      return add("s3", deviceId, settings, admin);
    },

    // A Google sign-in plus the folder chosen for it: sets up the folder and checks a small file
    // goes up, comes back the same, and can be cleaned away, before the copy is saved
    async addDrive({ clientId, clientSecret, refreshToken }, deviceId, admin, place) {
      if (!deviceId && q.get.get("failsafe")) throw new CopyError("There's already a failsafe copy. Disconnect it first to switch.");
      if (deviceId && !q.device.get(deviceId)) throw new CopyError("That device doesn't exist.");
      if (!place?.folderId) {
        const name = String(place?.name ?? "").trim();
        if (!name || name.length > 200 || /[\\/]/.test(name)) throw new CopyError("Type a folder name (no slashes).");
        place = { name, parentId: place?.parentId || null };
      }
      if (place.folderId && list().some((x) => x.kind === "drive" && x.settings.rootId === place.folderId)) {
        throw new CopyError("Another off-site copy already uses that folder. Choose a different one, or make a new folder.");
      }
      const drive = createDrive({ clientId, clientSecret, refreshToken });
      const about = await drive.about();
      const folders = await driveFolders(drive, place);
      await testDrive(drive, folders.rootId);
      return { ...add("drive", deviceId, { clientId, clientSecret, refreshToken, email: about.email, ...folders }, admin), email: about.email, folderName: folders.folderName };
    },

    defaultFolderName,

    // Signed in again (the Google sign-in expired or was removed): same copy, new token
    async resignDrive(id, { clientId, clientSecret, refreshToken }) {
      const d = getDest(id);
      if (!d || d.kind !== "drive") throw new CopyError("That copy isn't a Google Drive.");
      const drive = createDrive({ clientId, clientSecret, refreshToken });
      const { email } = await drive.about();
      if (d.settings.email && email !== d.settings.email) {
        throw new CopyError(`That's ${email}, but this copy is on ${d.settings.email}. Sign in with ${d.settings.email}, or add a new copy.`);
      }
      await testDrive(drive, d.settings.rootId);
      q.setSettings.run(JSON.stringify({ ...d.settings, clientId, clientSecret, refreshToken, email }), id);
      Object.assign(stateOf(id), { nextPassAt: Date.now(), failures: 0, lastError: null, failingSince: null });
    },

    replaceS3Key(id, keyId, secret) {
      const d = getDest(id);
      q.setSettings.run(JSON.stringify({ ...d.settings, keyId, secret }), id);
      stateOf(id).nextPassAt = Date.now();
    },

    setPaused(id, paused) {
      q.setPaused.run(paused ? 1 : 0, id);
      if (!paused) stateOf(id).nextPassAt = Date.now();
    },

    // Check now, and look at everything again (also extends locks)
    syncNow(id) {
      const ids = id ? [id] : list().map((d) => d.id);
      for (const x of ids) Object.assign(stateOf(x), { nextPassAt: 0, lastFullScan: 0 });
      tick();
    },

    // Stops sending to this copy. Nothing already there is touched. The record of what was sent
    // is kept, so reconnecting the same place doesn't upload it all again.
    disconnect(id) {
      q.remove.run(id);
      states.delete(id);
    },

    // The Google sign-in setup (OAuth client, and the API key and project number for the folder
    // picker), made once in Google Cloud
    googleClient() {
      const v = meta("google_client");
      return v ? JSON.parse(v) : null;
    },
    setGoogleClient(g) {
      q.setMeta.run("google_client", JSON.stringify(g));
    },

    pass,
  };
}
