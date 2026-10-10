// Admin accounts, login sessions, the audit log and a few dashboard queries.
// Uses its own connection to the same gateway.db file.

import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const SESSION_IDLE_MS = 60 * 60 * 1000;          // logged out after 1 hour of no activity
export const SESSION_MAX_MS = 12 * 60 * 60 * 1000;      // and always after 12 hours

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

export function openAdminStore(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "gateway.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS admins (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      last_login_at TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash   TEXT PRIMARY KEY,
      admin_id     INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      ip           TEXT,
      user_agent   TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      at      TEXT NOT NULL,
      actor   TEXT NOT NULL,
      action  TEXT NOT NULL,
      details TEXT,
      ip      TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const q = {
    countAdmins: db.prepare("SELECT COUNT(*) AS n FROM admins"),
    adminByName: db.prepare("SELECT * FROM admins WHERE username = ?"),
    addAdmin: db.prepare("INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)"),
    setPassword: db.prepare("UPDATE admins SET password_hash = ? WHERE id = ?"),
    touchLogin: db.prepare("UPDATE admins SET last_login_at = ? WHERE id = ?"),
    addSession: db.prepare(
      "INSERT INTO admin_sessions (token_hash, admin_id, created_at, last_used_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)"
    ),
    getSession: db.prepare(`
      SELECT s.*, a.username FROM admin_sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?
    `),
    touchSession: db.prepare("UPDATE admin_sessions SET last_used_at = ? WHERE token_hash = ?"),
    deleteSession: db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?"),
    deleteAdminSessions: db.prepare("DELETE FROM admin_sessions WHERE admin_id = ?"),
    expireSessions: db.prepare("DELETE FROM admin_sessions WHERE last_used_at < ? OR created_at < ?"),
    addAudit: db.prepare("INSERT INTO audit_log (at, actor, action, details, ip) VALUES (?, ?, ?, ?, ?)"),
    listAudit: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?"),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),

    // Dashboard queries
    versionStats: db.prepare(`
      SELECT device_id, COUNT(*) AS versions, COUNT(DISTINCT rel_path) AS paths, MAX(received_at) AS last_backup
      FROM file_versions GROUP BY device_id
    `),
    activitySince: db.prepare(`
      SELECT rel_path, version_no, type, size, received_at, status FROM file_versions
      WHERE device_id = ? AND received_at >= ? ORDER BY received_at
    `),
    versionsOfFile: db.prepare(`
      SELECT version_no, type, size, sha256, received_at, status, reasons FROM file_versions
      WHERE device_id = ? AND rel_path = ? ORDER BY version_no DESC
    `),
  };

  return {
    countAdmins: () => q.countAdmins.get().n,
    adminByName: (username) => q.adminByName.get(username),
    addAdmin: (username, passwordHash) => q.addAdmin.run(username, passwordHash, new Date().toISOString()),
    setPassword: (adminId, passwordHash) => {
      q.setPassword.run(passwordHash, adminId);
      q.deleteAdminSessions.run(adminId); // log out everywhere after a password change
    },
    recordLogin: (adminId) => q.touchLogin.run(new Date().toISOString(), adminId),

    // Sessions: the browser gets a random token; we only store its SHA-256 hash
    createSession(adminId, ip, userAgent) {
      const token = crypto.randomBytes(32).toString("base64url");
      const now = Date.now();
      q.addSession.run(sha256(token), adminId, now, now, ip ?? null, String(userAgent ?? "").slice(0, 200));
      return token;
    },
    findSession(token) {
      if (!token) return null;
      const now = Date.now();
      q.expireSessions.run(now - SESSION_IDLE_MS, now - SESSION_MAX_MS);
      const session = q.getSession.get(sha256(token));
      if (!session) return null;
      q.touchSession.run(now, session.token_hash);
      return session;
    },
    deleteSession: (token) => token && q.deleteSession.run(sha256(token)),

    audit: (actor, action, details, ip) =>
      q.addAudit.run(new Date().toISOString(), actor, action, details ? JSON.stringify(details) : null, ip ?? null),
    listAudit: (limit = 100) => q.listAudit.all(limit).map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })),

    getSetting: (key) => {
      const row = q.getSetting.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting: (key, value) => q.setSetting.run(key, JSON.stringify(value)),

    versionStats: () => q.versionStats.all(),
    activitySince: (deviceId, sinceIso) => q.activitySince.all(deviceId, sinceIso),
    versionsOfFile: (deviceId, relPath) => q.versionsOfFile.all(deviceId, relPath),

    close: () => db.close(),
  };
}