// Admin API for the Security page: what the antivirus and ransomware checks are seeing.
//   GET  /security/overview?range=24h|7d|30d   numbers, timeline, top detections, devices at risk
//   GET  /security/events?after=&before=&severity=&kind=&device=&q=&limit=
//   GET  /security/events/:id                  one event, with the file version it's about
//   POST /security/rescan  { days }            scan kept backups again (0 = all of them)
//   POST /security/stop                        stop a running rescan
//   POST /security/check                       ask ClamAV for its status now

import { SEVERITIES } from "../security.js";
import { REASON_TEXT } from "../inspect.js";

const RANGES = {
  "24h": { ms: 24 * 3600e3, bucket: "hour", buckets: 24 },
  "7d": { ms: 7 * 864e5, bucket: "6h", buckets: 28 },
  "30d": { ms: 30 * 864e5, bucket: "day", buckets: 30 },
};
const WEIGHT = { info: 0, low: 1, medium: 2, high: 6, critical: 15 };

export function securityRoutes({ db, security, scanner, broker, ApiError }) {
  const conn = security.conn;
  const q = {
    statsSince: conn.prepare("SELECT * FROM scan_stats WHERE hour >= ? ORDER BY hour"),
    eventsSince: conn.prepare("SELECT at, severity, kind, device_id FROM security_events WHERE at >= ?"),
    topSignatures: conn.prepare(`
      SELECT json_extract(detail, '$.signature') AS signature, COUNT(*) AS n, MAX(at) AS last
      FROM security_events WHERE kind = 'malware.detected' AND at >= ?
      GROUP BY signature ORDER BY n DESC, last DESC LIMIT 8`),
    coverage: conn.prepare(`
      SELECT
        SUM(scan_status IN ('clean', 'infected')) AS scanned,
        SUM(scan_status = 'too-big') AS too_big,
        SUM(scan_status IS NULL OR scan_status IN ('pending', 'off')) AS unscanned,
        COUNT(*) AS total
      FROM file_versions WHERE type <> 'deleted' AND received_at >= ?`),
    quarantinedByDevice: conn.prepare("SELECT device_id, COUNT(*) AS n FROM file_versions WHERE status = 'quarantined' GROUP BY device_id"),
    lastScanByDevice: conn.prepare("SELECT device_id, MAX(scanned_at) AS at FROM file_versions WHERE scanned_at IS NOT NULL GROUP BY device_id"),
    event: conn.prepare("SELECT * FROM security_events WHERE id = ?"),
    version: conn.prepare("SELECT id, device_id, rel_path, version_no, size, sha256, status, reasons, scan_status, scan_signature, scanned_at, received_at, entropy FROM file_versions WHERE id = ?"),
  };

  const devicesById = () => new Map(db.listDevices().map((d) => [d.id, d]));

  function publicEvent(e, devices) {
    const d = e.device_id ? devices.get(e.device_id) : null;
    return {
      id: e.id,
      at: e.at,
      severity: e.severity,
      kind: e.kind,
      title: e.title,
      deviceId: e.device_id,
      device: d?.device_name ?? null,
      client: d?.client_name ?? null,
      versionId: e.version_id,
      detail: e.detail ? JSON.parse(e.detail) : null,
    };
  }

  // Start of the time bucket an ISO time falls in
  function bucketOf(iso, bucket) {
    if (bucket === "hour") return iso.slice(0, 13);
    if (bucket === "day") return iso.slice(0, 10);
    const h = Number(iso.slice(11, 13));
    return `${iso.slice(0, 11)}${String(h - (h % 6)).padStart(2, "0")}`;
  }
  function bucketList(range) {
    const r = RANGES[range];
    const step = r.bucket === "hour" ? 3600e3 : r.bucket === "day" ? 864e5 : 6 * 3600e3;
    const out = [];
    const end = Date.now();
    for (let i = r.buckets - 1; i >= 0; i--) out.push(bucketOf(new Date(end - i * step).toISOString(), r.bucket));
    return [...new Set(out)];
  }

  return {
    "GET /security/overview"({ query }) {
      const range = RANGES[query.range] ? query.range : "24h";
      const r = RANGES[range];
      const since = new Date(Date.now() - r.ms).toISOString();
      const devices = devicesById();

      // Timeline: scans per bucket, and events by severity
      const keys = bucketList(range);
      const series = new Map(keys.map((k) => [k, { t: k, scanned: 0, infected: 0, suspicious: 0, events: Object.fromEntries(SEVERITIES.map((s) => [s, 0])) }]));
      const totals = { scanned: 0, bytes: 0, infected: 0, suspicious: 0, skipped: 0, ms: 0 };
      for (const row of q.statsSince.all(since.slice(0, 13))) {
        for (const k of Object.keys(totals)) totals[k] += row[k];
        const b = series.get(bucketOf(`${row.hour}:00:00.000Z`, r.bucket));
        if (b) {
          b.scanned += row.scanned;
          b.infected += row.infected;
          b.suspicious += row.suspicious;
        }
      }
      const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
      const deviceScore = new Map();
      for (const e of q.eventsSince.all(since)) {
        bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
        const b = series.get(bucketOf(e.at, r.bucket));
        if (b) b.events[e.severity]++;
        if (e.device_id) {
          const s = deviceScore.get(e.device_id) ?? { score: 0, critical: 0, high: 0, malware: 0, ransomware: 0, last: null };
          s.score += WEIGHT[e.severity] ?? 0;
          if (e.severity === "critical") s.critical++;
          if (e.severity === "high") s.high++;
          if (e.kind === "malware.detected") s.malware++;
          if (e.kind.startsWith("ransomware.") || e.kind === "device.frozen") s.ransomware++;
          if (!s.last || e.at > s.last) s.last = e.at;
          deviceScore.set(e.device_id, s);
        }
      }

      const quarantined = new Map(q.quarantinedByDevice.all().map((x) => [x.device_id, x.n]));
      const lastScan = new Map(q.lastScanByDevice.all().map((x) => [x.device_id, x.at]));
      const deviceRows = [...devices.values()]
        .filter((d) => d.status === "active")
        .map((d) => {
          const s = deviceScore.get(d.id) ?? { score: 0, critical: 0, high: 0, malware: 0, ransomware: 0, last: null };
          const score = s.score + (d.frozen_at ? 25 : 0) + Math.min(10, quarantined.get(d.id) ?? 0);
          const level = d.frozen_at || s.critical ? "critical" : score >= 12 ? "high" : score >= 4 ? "elevated" : "low";
          return {
            id: d.id, name: d.device_name, client: d.client_name, live: broker.isLive(d.id), frozen: !!d.frozen_at,
            frozenReason: d.frozen_reason, level, score, malware: s.malware, ransomware: s.ransomware,
            quarantined: quarantined.get(d.id) ?? 0, lastEvent: s.last, lastScan: lastScan.get(d.id) ?? null,
            agentVersion: d.agent_version,
          };
        })
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

      const cov = q.coverage.get(since);
      return {
        range,
        engine: scanner.status(),
        work: security.progress(),
        totals: { ...totals, events: Object.values(bySeverity).reduce((a, b) => a + b, 0) },
        bySeverity,
        coverage: { scanned: cov.scanned ?? 0, tooBig: cov.too_big ?? 0, unscanned: cov.unscanned ?? 0, total: cov.total ?? 0 },
        quarantined: db.quarantineCount(),
        frozen: deviceRows.filter((d) => d.frozen).length,
        timeline: [...series.values()],
        topSignatures: q.topSignatures.all(since).filter((x) => x.signature),
        devices: deviceRows,
      };
    },

    "GET /security/events"({ query }) {
      const where = [];
      const args = [];
      const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
      if (query.after) (where.push("e.id > ?"), args.push(Number(query.after)));
      if (query.before) (where.push("e.id < ?"), args.push(Number(query.before)));
      if (query.severity) {
        const list = String(query.severity).split(",").filter((s) => SEVERITIES.includes(s));
        if (list.length) (where.push(`e.severity IN (${list.map(() => "?").join(",")})`), args.push(...list));
      }
      if (query.kind) (where.push("e.kind LIKE ?"), args.push(`${String(query.kind).replace(/[%_]/g, "")}%`));
      if (query.device) (where.push("e.device_id = ?"), args.push(String(query.device)));
      if (query.q) {
        const like = `%${String(query.q).slice(0, 100).replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
        where.push("(e.title LIKE ? ESCAPE '\\' OR e.detail LIKE ? ESCAPE '\\' OR d.device_name LIKE ? ESCAPE '\\' OR d.client_name LIKE ? ESCAPE '\\')");
        args.push(like, like, like, like);
      }
      const rows = conn
        .prepare(`
          SELECT e.* FROM security_events e LEFT JOIN devices d ON d.id = e.device_id
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY e.id DESC LIMIT ${limit}`)
        .all(...args);
      const devices = devicesById();
      return { events: rows.map((e) => publicEvent(e, devices)), latestId: rows[0]?.id ?? null };
    },

    "GET /security/events/:id"({ params }) {
      const e = q.event.get(Number(params.id));
      if (!e) throw new ApiError(404, "Event not found");
      const event = publicEvent(e, devicesById());
      const v = e.version_id ? q.version.get(e.version_id) : null;
      return {
        event,
        version: v && {
          id: v.id, path: v.rel_path, versionNo: v.version_no, size: v.size, sha256: v.sha256, status: v.status,
          reasons: v.reasons ? JSON.parse(v.reasons).map((r) => REASON_TEXT[r] ?? r) : [],
          scanStatus: v.scan_status, signature: v.scan_signature, scannedAt: v.scanned_at, receivedAt: v.received_at, entropy: v.entropy,
        },
      };
    },

    "POST /security/rescan"({ body, admin }) {
      if (!scanner.usable) throw new ApiError(409, "The antivirus isn't running, so nothing can be scanned right now.");
      const days = Number(body.days ?? 7);
      if (!Number.isInteger(days) || days < 0 || days > 3650) throw new ApiError(400, "Pick how many days to rescan.");
      return security.rescan(days, admin.username);
    },

    "POST /security/stop"() {
      security.stopScan();
      return security.progress();
    },

    async "POST /security/check"() {
      await security.checkNow();
      return scanner.status();
    },
  };
}
