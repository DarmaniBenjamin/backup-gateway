// The agent's local database (SQLite, built into Node).
// "files"   = what the agent last knew about every file (the source of truth)
// "changes" = queue of changes waiting to be sent to the gateway

import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, "agent.db"));

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

    CREATE TABLE IF NOT EXISTS files (
      rel_path   TEXT PRIMARY KEY,
      size       INTEGER NOT NULL,
      mtime_ms   INTEGER NOT NULL,
      sha256     TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS changes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT NOT NULL CHECK (type IN ('added', 'changed', 'deleted')),
      rel_path    TEXT NOT NULL,
      size        INTEGER,
      sha256      TEXT,
      detected_at TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending'
    );

    CREATE INDEX IF NOT EXISTS idx_changes_status ON changes (status);
  `);

  const q = {
    getFile: db.prepare("SELECT * FROM files WHERE rel_path = ?"),
    upsertFile: db.prepare(`
      INSERT INTO files (rel_path, size, mtime_ms, sha256, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(rel_path) DO UPDATE SET
        size = excluded.size, mtime_ms = excluded.mtime_ms,
        sha256 = excluded.sha256, updated_at = excluded.updated_at
    `),
    deleteFile: db.prepare("DELETE FROM files WHERE rel_path = ?"),
    filesUnder: db.prepare("SELECT rel_path FROM files WHERE rel_path LIKE ? ESCAPE '\\'"),
    allPaths: db.prepare("SELECT rel_path FROM files"),
    countFiles: db.prepare("SELECT COUNT(*) AS n FROM files"),
    addChange: db.prepare(`
      INSERT INTO changes (type, rel_path, size, sha256, detected_at)
      VALUES (?, ?, ?, ?, ?)
    `),
    countPending: db.prepare("SELECT COUNT(*) AS n FROM changes WHERE status = 'pending'"),
  };

  return {
    getFile: (relPath) => q.getFile.get(relPath),
    saveFile: (relPath, size, mtimeMs, sha256) =>
      q.upsertFile.run(relPath, size, Math.round(mtimeMs), sha256, new Date().toISOString()),
    removeFile: (relPath) => q.deleteFile.run(relPath),
    filesUnder: (relDir) => {
      const escaped = relDir.replace(/[\\%_]/g, (c) => "\\" + c);
      return q.filesUnder.all(`${escaped}/%`).map((r) => r.rel_path);
    },
    allPaths: () => q.allPaths.all().map((r) => r.rel_path),
    countFiles: () => q.countFiles.get().n,
    recordChange: (type, relPath, size, sha256) =>
      q.addChange.run(type, relPath, size ?? null, sha256 ?? null, new Date().toISOString()),
    countPending: () => q.countPending.get().n,
    transaction: (fn) => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    close: () => db.close(),
  };
}