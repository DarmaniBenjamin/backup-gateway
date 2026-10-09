// The gateway's database (SQLite, built into Node).
// "enrollment_codes" = one-time codes for adding new devices (only the SHA-256 hash is stored)
// "devices"          = enrolled agents and their PUBLIC keys (private keys never leave the agent)
// "chunks"           = which encrypted chunks each device has uploaded
// "file_versions"    = every version of every file, and which chunks it's made of

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
  `);

  // Upgrade older databases: add columns that didn't exist in earlier versions
  const deviceColumns = db.prepare("PRAGMA table_info(devices)").all().map((c) => c.name);
  if (!deviceColumns.includes("kx_public_key")) {
    db.exec("ALTER TABLE devices ADD COLUMN kx_public_key TEXT");
  }

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
        (device_id, rel_path, version_no, type, size, sha256, mtime_ms, chunk_ids, agent_change_id, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listVersions: db.prepare(`
      SELECT v.*, d.device_name, d.client_name FROM file_versions v
      JOIN devices d ON d.id = v.device_id
      ORDER BY d.client_name, d.device_name, v.rel_path, v.version_no
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
          v.mtimeMs ?? null, v.chunkIds ? JSON.stringify(v.chunkIds) : null, v.changeId, now()
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

    close: () => db.close(),
  };
}