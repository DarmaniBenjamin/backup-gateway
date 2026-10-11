// The gateway's security record and the antivirus around it:
//   - security_events: one row per thing worth knowing (malware found, ransomware signs, a device
//     frozen, ClamAV down, new signatures, quarantine decisions...). The Security page shows them.
//   - scan_stats: how many files were scanned per hour, and what was found, for the charts.
//   - a monitor that checks ClamAV every few minutes, notices new signatures and rescans the
//     last week's backups with them (catches malware that was too new to recognise at first).
//   - a background worker that scans backups that couldn't be scanned when they arrived (ClamAV
//     was down, or not installed yet), and full rescans asked for on the Security page.

import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { open } from "./crypto-box.js";
import { log } from "./logger.js";

export const SEVERITIES = ["info", "low", "medium", "high", "critical"];
const MONITOR_EVERY_MS = 5 * 60_000;
const RESCAN_RECENT_DAYS = 7;
const BATCH = 200;

export function createSecurity({ db, dataDir, keys, storage, scanner }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS security_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         TEXT NOT NULL,
      severity   TEXT NOT NULL,
      kind       TEXT NOT NULL,
      device_id  TEXT,
      title      TEXT NOT NULL,
      detail     TEXT,
      version_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_at ON security_events (at);
    CREATE INDEX IF NOT EXISTS idx_security_events_device ON security_events (device_id, at);
    CREATE TABLE IF NOT EXISTS scan_stats (
      hour        TEXT PRIMARY KEY,      -- 2026-10-11T14 (UTC)
      scanned     INTEGER NOT NULL DEFAULT 0,
      bytes       INTEGER NOT NULL DEFAULT 0,
      infected    INTEGER NOT NULL DEFAULT 0,
      suspicious  INTEGER NOT NULL DEFAULT 0,
      skipped     INTEGER NOT NULL DEFAULT 0,
      ms          INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS security_meta (
      name  TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  conn.exec("CREATE INDEX IF NOT EXISTS idx_versions_scan ON file_versions (scan_status) WHERE scan_status IS NULL OR scan_status IN ('pending', 'off')");

  const q = {
    addEvent: conn.prepare("INSERT INTO security_events (at, severity, kind, device_id, title, detail, version_id) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    stat: conn.prepare(`
      INSERT INTO scan_stats (hour, scanned, bytes, infected, suspicious, skipped, ms) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (hour) DO UPDATE SET scanned = scanned + excluded.scanned, bytes = bytes + excluded.bytes,
        infected = infected + excluded.infected, suspicious = suspicious + excluded.suspicious,
        skipped = skipped + excluded.skipped, ms = ms + excluded.ms`),
    getMeta: conn.prepare("SELECT value FROM security_meta WHERE name = ?"),
    setMeta: conn.prepare("INSERT OR REPLACE INTO security_meta (name, value) VALUES (?, ?)"),
    // Not scanned yet (newest first, so today's files are covered before old history)
    backlog: conn.prepare(`
      SELECT id, device_id, rel_path, size, sha256, chunk_ids, status FROM file_versions
      WHERE (scan_status IS NULL OR scan_status IN ('pending', 'off')) AND type <> 'deleted' AND chunk_ids IS NOT NULL
        AND status IN ('ok', 'quarantined')
      ORDER BY id DESC LIMIT ?`),
    backlogCount: conn.prepare(`
      SELECT COUNT(*) AS n FROM file_versions
      WHERE (scan_status IS NULL OR scan_status IN ('pending', 'off')) AND type <> 'deleted' AND chunk_ids IS NOT NULL
        AND status IN ('ok', 'quarantined')`),
    // A rescan: every kept version since a time (good ones only; quarantined ones are held anyway)
    rescanBatch: conn.prepare(`
      SELECT id, device_id, rel_path, size, sha256, chunk_ids, status FROM file_versions
      WHERE id > ? AND received_at >= ? AND type <> 'deleted' AND chunk_ids IS NOT NULL AND status = 'ok'
      ORDER BY id LIMIT ?`),
    rescanCount: conn.prepare(`
      SELECT COUNT(*) AS n FROM file_versions
      WHERE received_at >= ? AND type <> 'deleted' AND chunk_ids IS NOT NULL AND status = 'ok'`),
    setScan: conn.prepare("UPDATE file_versions SET scan_status = ?, scan_signature = ?, scanned_at = ? WHERE id = ?"),
    quarantineInfected: conn.prepare(`
      UPDATE file_versions SET status = 'quarantined', scan_status = 'infected', scan_signature = ?, scanned_at = ?,
        reasons = json_insert(COALESCE(reasons, '[]'), '$[#]', 'malware')
      WHERE id = ? AND status = 'ok'`),
    device: conn.prepare("SELECT * FROM devices WHERE id = ?"),
  };

  const now = () => new Date().toISOString();
  const listeners = new Set();

  function event(severity, kind, title, { deviceId = null, versionId = null, detail = null } = {}) {
    const row = { at: now(), severity, kind, deviceId, title, detail, versionId };
    const id = Number(q.addEvent.run(row.at, severity, kind, deviceId, title, detail ? JSON.stringify(detail) : null, versionId).lastInsertRowid);
    for (const fn of listeners) {
      try {
        fn({ id, ...row });
      } catch (err) {
        log.warn(`Security event listener failed: ${err.message}`);
      }
    }
    return id;
  }

  function countStat({ scanned = 0, bytes = 0, infected = 0, suspicious = 0, skipped = 0, ms = 0 }) {
    q.stat.run(now().slice(0, 13), scanned, bytes, infected, suspicious, skipped, ms);
  }

  const meta = (name) => q.getMeta.get(name)?.value ?? null;

  // ---- Rebuilding one stored version and scanning it ------------------------------------------

  async function scanStored(v) {
    const device = q.device.get(v.device_id);
    const k = device && keys.forDevice(device);
    if (!k) return { status: "pending", message: "no keys for this device yet" };
    const scan = scanner.stream();
    try {
      for (const id of JSON.parse(v.chunk_ids)) {
        await scan.write(open(k.encKey, storage.readChunk(v.device_id, id), `chunk:${id}`));
      }
    } catch (err) {
      scan.abort();
      return { status: "pending", message: `couldn't read the stored file: ${err.message}` };
    }
    return scan.end();
  }

  // A version that was kept as good turned out to be malware (new signatures, or a late scan)
  function foundLater(v, result, why) {
    const changed = q.quarantineInfected.run(result.signature, now(), v.id).changes === 1;
    if (!changed) {
      q.setScan.run("infected", result.signature, now(), v.id);
      return;
    }
    const device = q.device.get(v.device_id);
    const where = `${v.rel_path} on ${device?.device_name ?? v.device_id}`;
    log.error(`Antivirus: ${result.signature} in ${where} (${why}); moved to quarantine`);
    event("critical", "malware.detected", `${result.signature} found in ${where}`, {
      deviceId: v.device_id, versionId: v.id,
      detail: { signature: result.signature, path: v.rel_path, sha256: v.sha256, size: v.size, when: why, previouslyKept: true },
    });
    db.addAlert(v.device_id, "malware", `Malware (${result.signature}) was found in ${where} when it was ${why}. That version is now in quarantine; check it, and the device.`);
  }

  // ---- Background work: the unscanned backlog, and rescans -------------------------------------

  const work = { running: false, kind: null, done: 0, total: 0, found: 0, startedAt: null, cursor: 0, since: null, reason: null };
  let stopRequested = false;

  async function runBacklog() {
    const total = q.backlogCount.get().n;
    if (!total) return;
    Object.assign(work, { kind: "backlog", done: 0, total, found: 0, startedAt: now(), reason: "not scanned yet" });
    log.info(`Antivirus: scanning ${total} backed-up file version(s) that weren't scanned yet`);
    let clearedPending = false;
    while (!stopRequested && scanner.usable) {
      const rows = q.backlog.all(BATCH);
      if (!rows.length) break;
      let progressed = false;
      for (const v of rows) {
        if (stopRequested || !scanner.usable) break;
        const r = await scanStored(v);
        if (r.status === "pending") continue;
        progressed = true;
        clearedPending = true;
        countStat({ scanned: r.status === "clean" || r.status === "infected" ? 1 : 0, bytes: r.bytes, infected: r.status === "infected" ? 1 : 0, skipped: r.status === "too-big" ? 1 : 0, ms: r.ms });
        if (r.status === "infected") {
          work.found++;
          if (v.status === "ok") foundLater(v, r, "scanned after arriving");
          else q.setScan.run("infected", r.signature, now(), v.id);
        } else {
          q.setScan.run(r.status, null, now(), v.id);
        }
        work.done++;
      }
      if (!progressed) break; // ClamAV keeps failing on these: try again on the next round
    }
    event(work.found ? "high" : "info", "scan.backlog", `Scanned ${work.done.toLocaleString()} backed-up file(s) that hadn't been scanned yet${work.found ? `: ${work.found} infected` : ""}`, {
      detail: { scanned: work.done, infected: work.found },
    });
    if (clearedPending) onPendingCleared?.();
  }

  async function runRescan(since, reason) {
    const total = q.rescanCount.get(since).n;
    Object.assign(work, { kind: "rescan", done: 0, total, found: 0, startedAt: now(), cursor: 0, since, reason });
    log.info(`Antivirus: rescanning ${total} file version(s) since ${since.slice(0, 10)} (${reason})`);
    while (!stopRequested && scanner.usable) {
      const rows = q.rescanBatch.all(work.cursor, since, BATCH);
      if (!rows.length) break;
      for (const v of rows) {
        if (stopRequested || !scanner.usable) break;
        work.cursor = v.id;
        const r = await scanStored(v);
        if (r.status === "pending") continue;
        countStat({ scanned: r.status === "clean" || r.status === "infected" ? 1 : 0, bytes: r.bytes, infected: r.status === "infected" ? 1 : 0, ms: r.ms });
        if (r.status === "infected") {
          work.found++;
          foundLater(v, r, "rescanned with newer signatures");
        } else {
          q.setScan.run(r.status, null, now(), v.id);
        }
        work.done++;
      }
    }
    const finished = work.done >= work.total || !stopRequested;
    event(work.found ? "high" : "info", "scan.rescan", `Rescan ${finished ? "finished" : "stopped"}: ${work.done.toLocaleString()} file(s) checked${work.found ? `, ${work.found} infected` : ", nothing found"}`, {
      detail: { reason, since, scanned: work.done, infected: work.found },
    });
  }

  const queue = []; // rescans waiting: { since, reason }
  async function pump() {
    if (work.running || !scanner.usable) return;
    work.running = true;
    stopRequested = false;
    try {
      await runBacklog();
      while (queue.length && !stopRequested && scanner.usable) {
        const job = queue.shift();
        await runRescan(job.since, job.reason);
      }
    } catch (err) {
      log.error("Antivirus background scan failed", err);
    } finally {
      Object.assign(work, { running: false, kind: null });
    }
  }

  // ---- Monitor: is ClamAV up, and are there new signatures? ------------------------------------

  let engineUp = null; // what the last check (or failed scan) said, so up/down is told once
  function engineDown(detail) {
    if (engineUp === false) return;
    engineUp = false;
    event("high", "engine.down", "Antivirus stopped answering. New files are kept, and scanned once it's back.", { detail });
  }
  scanner.onUnavailable((message) => engineDown({ message }));

  async function monitor() {
    const s = await scanner.check();
    if (s.available && engineUp !== true) {
      engineUp = true;
      event("info", "engine.up", `Antivirus ready: ClamAV ${s.engine ?? ""}${s.signatures ? `, signatures ${s.signatures}` : ""}`.trim(), { detail: s });
    } else if (!s.available && scanner.everSeen) {
      engineDown(s);
    } else if (!s.available && s.enabled && meta("engine_missing_noted") !== "1") {
      q.setMeta.run("engine_missing_noted", "1");
      event("medium", "engine.missing", "No antivirus on this gateway yet: files are checked for ransomware signs only. Install ClamAV to scan for malware.", { detail: s });
    }
    if (s.available && s.signatures) {
      const last = Number(meta("signatures") ?? 0);
      if (s.signatures !== last) {
        q.setMeta.run("signatures", String(s.signatures));
        if (last) {
          event("info", "engine.signatures", `Antivirus signatures updated to ${s.signatures}`, { detail: { from: last, to: s.signatures, date: s.signaturesDate } });
          // Malware that was too new to recognise last week may be recognised now
          queue.push({ since: new Date(Date.now() - RESCAN_RECENT_DAYS * 864e5).toISOString(), reason: `new signatures ${s.signatures}` });
        }
      }
    }
    pump();
  }

  let timer = null;
  let onPendingCleared = null;

  return {
    event,
    onEvent: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    countStat,
    conn,

    start({ pendingCleared } = {}) {
      onPendingCleared = pendingCleared;
      monitor().catch((err) => log.error("Antivirus monitor failed", err));
      timer = setInterval(() => monitor().catch((err) => log.error("Antivirus monitor failed", err)), MONITOR_EVERY_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      stopRequested = true;
    },
    checkNow: () => monitor(),

    // Asked for on the Security page: rescan everything kept since `days` ago (0 = all of it)
    rescan(days, by) {
      const since = days ? new Date(Date.now() - days * 864e5).toISOString() : "0000";
      queue.push({ since, reason: `asked for by ${by}` });
      event("info", "scan.requested", `${by} started a rescan of ${days ? `the last ${days} day(s)` : "every backup"}`);
      pump();
      return this.progress();
    },
    stopScan() {
      queue.length = 0;
      stopRequested = true;
    },
    progress: () => ({
      running: work.running,
      kind: work.kind,
      done: work.done,
      total: work.total,
      found: work.found,
      startedAt: work.startedAt,
      reason: work.reason,
      queued: queue.length,
      backlog: q.backlogCount.get().n,
    }),
  };
}
