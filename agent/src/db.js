// The agent's local database (SQLite, built into Node).
// "files"   = what the agent last knew about every file (the source of truth)
// "changes" = queue of changes waiting to be sent to the gateway
//             status: pending -> sent (or superseded / skipped)
// "jobs_done" = jobs from the gateway (like restores) already carried out, so none ever runs twice
// "folders"   = the backup folders, as last received from the gateway (so they work offline too)
// "settings"  = small bits of state, like which folder list version is applied
//
// Paths start with the backup folder's name: "Documents/report.docx".

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

    CREATE TABLE IF NOT EXISTS jobs_done (
      id          INTEGER PRIMARY KEY,
      result      TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS folders (
      name     TEXT PRIMARY KEY,
      id       TEXT NOT NULL,
      path     TEXT NOT NULL,
      excludes TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Upgrade older databases: add columns that didn't exist in earlier versions
  const changeColumns = db.prepare("PRAGMA table_info(changes)").all().map((c) => c.name);
  if (!changeColumns.includes("sent_at")) db.exec("ALTER TABLE changes ADD COLUMN sent_at TEXT");
  if (!changeColumns.includes("version_no")) db.exec("ALTER TABLE changes ADD COLUMN version_no INTEGER");

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
    nextPending: db.prepare("SELECT * FROM changes WHERE status = 'pending' ORDER BY id LIMIT ?"),
    hasLaterPending: db.prepare(
      "SELECT 1 FROM changes WHERE status = 'pending' AND rel_path = ? AND id > ? LIMIT 1"
    ),
    setStatus: db.prepare("UPDATE changes SET status = ? WHERE id = ?"),
    getJobDone: db.prepare("SELECT * FROM jobs_done WHERE id = ?"),
    addJobDone: db.prepare("INSERT OR REPLACE INTO jobs_done (id, result, finished_at) VALUES (?, ?, ?)"),
    markSent: db.prepare("UPDATE changes SET status = 'sent', sent_at = ?, version_no = ? WHERE id = ?"),
    listFolders: db.prepare("SELECT * FROM folders ORDER BY name"),
    clearFolders: db.prepare("DELETE FROM folders"),
    addFolder: db.prepare("INSERT INTO folders (name, id, path, excludes) VALUES (?, ?, ?, ?)"),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    deleteSetting: db.prepare("DELETE FROM settings WHERE key = ?"),
    prefixFiles: db.prepare("UPDATE files SET rel_path = ? || '/' || rel_path"),
    prefixChanges: db.prepare("UPDATE changes SET rel_path = ? || '/' || rel_path"),
    forgetUnder: db.prepare("DELETE FROM files WHERE rel_path LIKE ? ESCAPE '\\'"),
    skipUnder: db.prepare("UPDATE changes SET status = 'skipped' WHERE status = 'pending' AND rel_path LIKE ? ESCAPE '\\'"),
    statsUnder: db.prepare("SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files WHERE rel_path LIKE ? ESCAPE '\\'"),
  };

  // LIKE pattern for everything inside a folder (escaping % and _ in names)
  const under = (name) => `${name.replace(/[\\%_]/g, (c) => "\\" + c)}/%`;

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
    nextPending: (limit = 50) => q.nextPending.all(limit),
    hasLaterPending: (relPath, id) => !!q.hasLaterPending.get(relPath, id),
    setChangeStatus: (id, status) => q.setStatus.run(status, id),
    getJobDone: (id) => {
      const row = q.getJobDone.get(id);
      return row ? JSON.parse(row.result) : null;
    },
    saveJobDone: (id, result) => q.addJobDone.run(id, JSON.stringify(result), new Date().toISOString()),
    markChangeSent: (id, versionNo) => q.markSent.run(new Date().toISOString(), versionNo ?? null, id),
    // Backup folders
    listFolders: () => q.listFolders.all().map((f) => ({ ...f, excludes: JSON.parse(f.excludes) })),
    replaceFolders(list) {
      db.exec("BEGIN");
      try {
        q.clearFolders.run();
        for (const f of list) q.addFolder.run(f.name, f.id, f.path, JSON.stringify(f.excludes ?? []));
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    getSetting: (key) => {
      const row = q.getSetting.get(key);
      return row ? JSON.parse(row.value) : null;
    },
    setSetting: (key, value) => q.setSetting.run(key, JSON.stringify(value)),
    deleteSetting: (key) => q.deleteSetting.run(key),
    // One-time upgrade from the single-folder days: every path moves under the folder's name
    prefixAllPaths(name) {
      db.exec("BEGIN");
      try {
        q.prefixFiles.run(name);
        q.prefixChanges.run(name);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    // A folder is no longer backed up: forget its files WITHOUT recording them as deleted
    forgetFolder(name) {
      const pattern = under(name);
      return { forgotten: Number(q.forgetUnder.run(pattern).changes), skipped: Number(q.skipUnder.run(pattern).changes) };
    },
    folderStats: (name) => q.statsUnder.get(under(name)),

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