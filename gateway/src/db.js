// The gateway's database (SQLite, built into Node).
// "enrollment_codes" = one-time codes for adding new devices (only the SHA-256 hash is stored)
// "devices"          = enrolled agents and their PUBLIC keys (private keys never leave the agent)
// "chunks"           = which encrypted chunks each device has uploaded
// "file_versions"    = every version of every file, and which chunks it's made of
// "commands"         = jobs for agents to carry out (e.g. restores), picked up on their next heartbeat
// "alerts"           = things an admin needs to look at (quarantined files, frozen devices)
//
// Every file version has a status: "ok", "quarantined" (suspected ransomware, waiting for review)
// or "rejected". Only "ok" versions are ever used for browsing and restoring.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "gateway.db"));

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS enrollment_codes (
      code_hash   TEXT PRIMARY KEY,
      client_name TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT,
      used_by     TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id             TEXT PRIMARY KEY,
      client_name    TEXT NOT NULL,
      device_name    TEXT NOT NULL,
      public_key     TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
      enrolled_at    TEXT NOT NULL,
      enrolled_ip    TEXT,
      last_seen_at   TEXT,
      last_seen_ip   TEXT,
      agent_version  TEXT,
      files_tracked  INTEGER,
      pending_changes INTEGER
    );

    CREATE TABLE IF NOT EXISTS chunks (
      device_id  TEXT NOT NULL REFERENCES devices(id),
      chunk_id   TEXT NOT NULL,
      plain_size INTEGER NOT NULL,
      box_size   INTEGER NOT NULL,
      stored_at  TEXT NOT NULL,
      PRIMARY KEY (device_id, chunk_id)
    );

    CREATE TABLE IF NOT EXISTS file_versions (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id       TEXT NOT NULL REFERENCES devices(id),
      rel_path        TEXT NOT NULL,
      version_no      INTEGER NOT NULL,
      type            TEXT NOT NULL CHECK (type IN ('added', 'changed', 'deleted')),
      size            INTEGER,
      sha256          TEXT,
      mtime_ms        INTEGER,
      chunk_ids       TEXT,
      agent_change_id INTEGER NOT NULL,
      received_at     TEXT NOT NULL,
      UNIQUE (device_id, agent_change_id),
      UNIQUE (device_id, rel_path, version_no)
    );
    CREATE INDEX IF NOT EXISTS idx_versions_path ON file_versions (device_id, rel_path);

    CREATE TABLE IF NOT EXISTS commands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id   TEXT NOT NULL REFERENCES devices(id),
      type        TEXT NOT NULL,
      payload     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      finished_at TEXT,
      result      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_commands_device ON commands (device_id, status);

    CREATE TABLE IF NOT EXISTS alerts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id       TEXT REFERENCES devices(id),
      kind            TEXT NOT NULL,
      message         TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      acknowledged_at TEXT,
      acknowledged_by TEXT
    );
  `);

  // Upgrade older databases: add columns that didn't exist in earlier versions
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all().map((c) => c.name);
  if (!deviceColumns.includes("kx_public_key")) {
    db.exec("ALTER TABLE devices ADD COLUMN kx_public_key TEXT");
  }
  if (!deviceColumns.includes("frozen_at")) {
    db.exec("ALTER TABLE devices ADD COLUMN frozen_at TEXT");
    db.exec("ALTER TABLE devices ADD COLUMN frozen_reason TEXT");
  }
  if (!deviceColumns.includes("unfrozen_at")) db.exec("ALTER TABLE devices ADD COLUMN unfrozen_at TEXT");
  const versionColumns = db.prepare("PRAGMA table_info(file_versions)").all().map((c) => c.name);
  if (!versionColumns.includes("status")) {
    db.exec("ALTER TABLE file_versions ADD COLUMN status TEXT NOT NULL DEFAULT 'ok'");
    db.exec("ALTER TABLE file_versions ADD COLUMN entropy REAL");
    db.exec("ALTER TABLE file_versions ADD COLUMN reasons TEXT");
    db.exec("ALTER TABLE file_versions ADD COLUMN reviewed_by TEXT");
    db.exec("ALTER TABLE file_versions ADD COLUMN reviewed_at TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_versions_status ON file_versions (device_id, status, received_at)");

  const q = {
    addCode: db.prepare(
      "INSERT INTO enrollment_codes (code_hash, client_name, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ),
    getCode: db.prepare("SELECT * FROM enrollment_codes WHERE code_hash = ?"),
    useCode: db.prepare(
      "UPDATE enrollment_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL"
    ),
    addDevice: db.prepare(`
      INSERT INTO devices (id, client_name, device_name, public_key, enrolled_at, enrolled_ip)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    getDevice: db.prepare("SELECT * FROM devices WHERE id = ?"),
    listDevices: db.prepare("SELECT * FROM devices ORDER BY client_name, device_name"),
    heartbeat: db.prepare(`
      UPDATE devices SET last_seen_at = ?, last_seen_ip = ?, agent_version = ?,
        files_tracked = ?, pending_changes = ?
      WHERE id = ?
    `),
    setKxKey: db.prepare("UPDATE devices SET kx_public_key = ? WHERE id = ?"),
    hasChunk: db.prepare("SELECT 1 FROM chunks WHERE device_id = ? AND chunk_id = ?"),
    getChunk: db.prepare("SELECT * FROM chunks WHERE device_id = ? AND chunk_id = ?"),
    removeChunk: db.prepare("DELETE FROM chunks WHERE device_id = ? AND chunk_id = ?"),
    addChunk: db.prepare(`
      INSERT OR IGNORE INTO chunks (device_id, chunk_id, plain_size, box_size, stored_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    versionByChange: db.prepare("SELECT * FROM file_versions WHERE device_id = ? AND agent_change_id = ?"),
    lastVersionNo: db.prepare(
      "SELECT MAX(version_no) AS n FROM file_versions WHERE device_id = ? AND rel_path = ?"
    ),
    addVersion: db.prepare(`
      INSERT INTO file_versions
        (device_id, rel_path, version_no, type, size, sha256, mtime_ms, chunk_ids, agent_change_id, received_at,
         status, entropy, reasons)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    lastOkVersion: db.prepare(`
      SELECT * FROM file_versions WHERE device_id = ? AND rel_path = ? AND status = 'ok'
      ORDER BY version_no DESC LIMIT 1
    `),
    countSince: db.prepare(`
      SELECT
        SUM(CASE WHEN reasons IS NOT NULL AND reasons NOT LIKE '%device-frozen%' THEN 1 ELSE 0 END) AS suspicious,
        SUM(CASE WHEN type = 'deleted' THEN 1 ELSE 0 END) AS deleted
      FROM file_versions WHERE device_id = ? AND received_at >= ?
    `),
    quarantineDeletesSince: db.prepare(`
      UPDATE file_versions SET status = 'quarantined', reasons = '["mass-delete"]'
      WHERE device_id = ? AND type = 'deleted' AND status = 'ok' AND received_at >= ?
    `),
    freeze: db.prepare("UPDATE devices SET frozen_at = ?, frozen_reason = ? WHERE id = ? AND frozen_at IS NULL"),
    unfreeze: db.prepare("UPDATE devices SET frozen_at = NULL, frozen_reason = NULL, unfrozen_at = ? WHERE id = ?"),
    listQuarantine: db.prepare(`
      SELECT v.*, d.device_name, d.client_name FROM file_versions v JOIN devices d ON d.id = v.device_id
      WHERE v.status = 'quarantined' ORDER BY v.received_at DESC LIMIT ?
    `),
    getVersion: db.prepare("SELECT * FROM file_versions WHERE id = ?"),
    setVersionStatus: db.prepare(
      "UPDATE file_versions SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ? AND status = 'quarantined'"
    ),
    addAlert: db.prepare("INSERT INTO alerts (device_id, kind, message, created_at) VALUES (?, ?, ?, ?)"),
    listAlerts: db.prepare(`
      SELECT a.*, d.device_name, d.client_name FROM alerts a LEFT JOIN devices d ON d.id = a.device_id
      ORDER BY a.acknowledged_at IS NOT NULL, a.id DESC LIMIT ?
    `),
    ackAlert: db.prepare("UPDATE alerts SET acknowledged_at = ?, acknowledged_by = ? WHERE id = ? AND acknowledged_at IS NULL"),
    openAlertCount: db.prepare("SELECT COUNT(*) AS n FROM alerts WHERE acknowledged_at IS NULL"),
    recentOpenAlert: db.prepare(
      "SELECT id FROM alerts WHERE device_id = ? AND kind = ? AND acknowledged_at IS NULL AND created_at >= ? LIMIT 1"
    ),
    listVersions: db.prepare(`
      SELECT v.*, d.device_name, d.client_name FROM file_versions v
      JOIN devices d ON d.id = v.device_id
      ORDER BY d.client_name, d.device_name, v.rel_path, v.version_no
    `),
    versionsUnder: db.prepare(`
      SELECT * FROM file_versions
      WHERE device_id = ? AND status = 'ok' AND (? = '' OR rel_path = ? OR rel_path LIKE ? ESCAPE '\\')
      ORDER BY rel_path, version_no
    `),
    addCommand: db.prepare(
      "INSERT INTO commands (device_id, type, payload, created_at) VALUES (?, ?, ?, ?)"
    ),
    getCommand: db.prepare("SELECT * FROM commands WHERE id = ?"),
    activeCommands: db.prepare(
      "SELECT * FROM commands WHERE device_id = ? AND status IN ('queued', 'running') ORDER BY id"
    ),
    startCommand: db.prepare(
      "UPDATE commands SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('queued', 'running')"
    ),
    finishCommand: db.prepare(
      "UPDATE commands SET status = ?, finished_at = ?, result = ? WHERE id = ? AND status IN ('queued', 'running')"
    ),
    listCommands: db.prepare(`
      SELECT c.*, d.device_name, d.client_name FROM commands c
      JOIN devices d ON d.id = c.device_id
      ORDER BY c.id DESC LIMIT ?
    `),
    storageStats: db.prepare(`
      SELECT device_id, COUNT(*) AS chunks, SUM(plain_size) AS plain, SUM(box_size) AS stored
      FROM chunks GROUP BY device_id
    `),
  };

  const now = () => new Date().toISOString();

  return {
    addCode: (codeHash, clientName, expiresAt) => q.addCode.run(codeHash, clientName, now(), expiresAt),
    getCode: (codeHash) => q.getCode.get(codeHash),
    getDevice: (id) => q.getDevice.get(id),
    listDevices: () => q.listDevices.all(),

    // Uses up the code and creates the device in one step, so a code can never be used twice
    enrollDevice: ({ codeHash, deviceId, clientName, deviceName, publicKey, ip }) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = q.useCode.run(now(), deviceId, codeHash);
        if (result.changes !== 1) throw new Error("CODE_ALREADY_USED");
        q.addDevice.run(deviceId, clientName, deviceName, publicKey, now(), ip);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },

    recordHeartbeat: (id, ip, { agentVersion, filesTracked, pendingChanges }) =>
      q.heartbeat.run(now(), ip, agentVersion ?? null, filesTracked ?? null, pendingChanges ?? null, id),

    setKxPublicKey: (id, pem) => q.setKxKey.run(pem, id),

    hasChunk: (deviceId, chunkId) => !!q.hasChunk.get(deviceId, chunkId),
    getChunk: (deviceId, chunkId) => q.getChunk.get(deviceId, chunkId),
    removeChunk: (deviceId, chunkId) => q.removeChunk.run(deviceId, chunkId),
    addChunk: (deviceId, chunkId, plainSize, boxSize) =>
      q.addChunk.run(deviceId, chunkId, plainSize, boxSize, now()),

    versionByChange: (deviceId, changeId) => q.versionByChange.get(deviceId, changeId),
    addVersion: (deviceId, v) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const versionNo = (q.lastVersionNo.get(deviceId, v.relPath).n ?? 0) + 1;
        // The first version the gateway ever sees of a file is always "added"
        const type = versionNo === 1 && v.type === "changed" ? "added" : v.type;
        q.addVersion.run(
          deviceId, v.relPath, versionNo, type, v.size ?? null, v.sha256 ?? null,
          v.mtimeMs ?? null, v.chunkIds ? JSON.stringify(v.chunkIds) : null, v.changeId, now(),
          v.status ?? "ok", v.entropy ?? null, v.reasons?.length ? JSON.stringify(v.reasons) : null
        );
        db.exec("COMMIT");
        return versionNo;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    listVersions: () => q.listVersions.all(),
    storageStats: () => q.storageStats.all(),

    // All versions of one file, or of every file inside a folder ("" = everything)
    versionsUnder: (deviceId, relPath) => {
      const escaped = relPath.replace(/[\\%_]/g, (c) => "\\" + c);
      return q.versionsUnder.all(deviceId, relPath, relPath, `${escaped}/%`);
    },

    addCommand: (deviceId, type, payload) =>
      Number(q.addCommand.run(deviceId, type, JSON.stringify(payload), now()).lastInsertRowid),
    getCommand: (id) => q.getCommand.get(id),
    activeCommands: (deviceId) => q.activeCommands.all(deviceId),
    startCommand: (id) => q.startCommand.run(now(), id),
    finishCommand: (id, status, result) => q.finishCommand.run(status, now(), JSON.stringify(result ?? null), id),
    listCommands: (limit = 20) => q.listCommands.all(limit),

    // Quarantine engine
    lastOkVersion: (deviceId, relPath) => q.lastOkVersion.get(deviceId, relPath),
    countSince: (deviceId, sinceIso) => {
      const r = q.countSince.get(deviceId, sinceIso);
      return { suspicious: r.suspicious ?? 0, deleted: r.deleted ?? 0 };
    },
    // Deletions that led up to a mass-delete freeze are pulled back, so the files stay restorable
    quarantineDeletesSince: (deviceId, sinceIso) => q.quarantineDeletesSince.run(deviceId, sinceIso).changes,
    freezeDevice: (deviceId, reason) => q.freeze.run(now(), reason, deviceId).changes === 1,
    unfreezeDevice: (deviceId) => q.unfreeze.run(now(), deviceId),
    listQuarantine: (limit = 500) => q.listQuarantine.all(limit),
    getVersion: (id) => q.getVersion.get(id),
    reviewVersion: (id, status, by) => q.setVersionStatus.run(status, by, now(), id).changes === 1,
    addAlert: (deviceId, kind, message) => Number(q.addAlert.run(deviceId, kind, message, now()).lastInsertRowid),
    hasRecentOpenAlert: (deviceId, kind, sinceIso) => !!q.recentOpenAlert.get(deviceId, kind, sinceIso),
    listAlerts: (limit = 100) => q.listAlerts.all(limit),
    ackAlert: (id, by) => q.ackAlert.run(now(), by, id).changes === 1,
    openAlertCount: () => q.openAlertCount.get().n,

    close: () => db.close(),
  };
}