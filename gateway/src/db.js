// The gateway's database (SQLite, built into Node).
// "enrollment_codes" = one-time codes for adding new devices (only the SHA-256 hash is stored)
// "devices"          = enrolled agents and their PUBLIC keys (private keys never leave the agent)

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
  `);

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

    close: () => db.close(),
  };
}