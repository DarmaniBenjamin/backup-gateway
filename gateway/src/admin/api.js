// The admin API used by the web UI. Every route except /login requires a valid session.
//
//   POST /admin/api/login                     { username, password }
//   POST /admin/api/logout
//   GET  /admin/api/me
//   GET  /admin/api/overview                  dashboard numbers
//   GET  /admin/api/devices
//   POST /admin/api/enrollment-codes          { clientName } -> one-time code (shown once)
//   GET  /admin/api/devices/:id/files         ?path=folder&at=ISO-date   browse backed-up files
//   GET  /admin/api/devices/:id/versions      ?path=file                 every version of one file
//   GET  /admin/api/devices/:id/activity      ?hours=24&bucket=15        changes over time (spot attacks)
//   POST /admin/api/restore/preview           { device, to, path, version, at, mode }
//   POST /admin/api/restore                   same body — creates the job
//   GET  /admin/api/jobs
//   POST /admin/api/verify                    run the integrity check now
//   GET  /admin/api/verify/last
//   GET  /admin/api/audit
//   GET  /admin/api/quarantine                 versions held back as suspected ransomware
//   POST /admin/api/quarantine/release         { ids } → become normal versions
//   POST /admin/api/quarantine/reject          { ids } → kept as evidence, never restorable
//   POST /admin/api/devices/:id/unfreeze       resume normal backups for a frozen device
//   GET  /admin/api/alerts
//   POST /admin/api/alerts/:id/ack
//   GET  /admin/api/devices/:id/folders                     backup folders + the device's allowed areas
//   POST /admin/api/devices/:id/browse                      { path } list folders on the device (live)
//   POST /admin/api/devices/:id/folders                     { path, excludes } start backing up a folder
//   POST /admin/api/devices/:id/folders/:folderId/excludes  { excludes }
//   POST /admin/api/devices/:id/folders/:folderId/remove    stop backing it up (backups are kept)
//   POST /admin/api/devices/:id/settings                    background settings (speed limits, pauses...)

import { createEnrollmentCode } from "../codes.js";
import { normalizePath, prepareRestore, RestoreError } from "../restore-plan.js";
import { runVerify } from "../verify.js";
import { verifyPassword, burnTime } from "./passwords.js";
import { REASON_TEXT } from "../inspect.js";
import {
  MAX_FOLDERS, cleanExcludes, folderNameFromPath, foldersOverlap, isInsidePath, isValidDevicePath, newFolderId, samePath,
} from "../folders.js";
import { SettingsError, cleanSettings, settingsOf } from "../device-settings.js";
import { log } from "../logger.js";

const ONLINE_WINDOW_MS = 90_000; // seen within 90 s (3 missed heartbeats) = online

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Brute-force protection: per IP and per username, in memory
const failures = new Map(); // key -> [timestamps]
const WINDOW_MS = 15 * 60 * 1000;
function recentFailures(key) {
  const now = Date.now();
  const list = (failures.get(key) || []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, list);
  return list;
}
function addFailure(key) {
  recentFailures(key).push(Date.now());
}

function deviceStatus(device) {
  if (device.status !== "active") return device.status;
  if (device.frozen_at) return "frozen";
  if (!device.last_seen_at) return "never-seen";
  return Date.now() - new Date(device.last_seen_at) < ONLINE_WINDOW_MS ? "online" : "offline";
}

export function createAdminApi({ db, store, keys, storage, config, broker }) {
  function publicDevice(d, stats) {
    const s = stats?.find((x) => x.device_id === d.id);
    const storageRow = db.storageStats().find((x) => x.device_id === d.id);
    return {
      id: d.id,
      name: d.device_name,
      client: d.client_name,
      status: deviceStatus(d),
      enrolledAt: d.enrolled_at,
      lastSeenAt: d.last_seen_at,
      lastSeenIp: d.last_seen_ip,
      agentVersion: d.agent_version,
      filesTracked: d.files_tracked,
      pendingChanges: d.pending_changes,
      encryptionReady: !!d.kx_public_key,
      platform: d.platform,
      multiFolder: (d.path_layout ?? 1) >= 2,
      live: broker.isLive(d.id),
      pausedReason: d.agent_status ? JSON.parse(d.agent_status).paused : null,
      frozenAt: d.frozen_at,
      frozenReason: d.frozen_reason,
      online: !!d.last_seen_at && Date.now() - new Date(d.last_seen_at) < ONLINE_WINDOW_MS,
      versions: s?.versions ?? 0,
      lastBackupAt: s?.last_backup ?? null,
      originalBytes: storageRow?.plain ?? 0,
      storedBytes: storageRow?.stored ?? 0,
    };
  }

  function getDeviceOr404(id) {
    const d = db.getDevice(id);
    if (!d) throw new ApiError(404, "Device not found");
    return d;
  }

  function publicJob(j) {
    const payload = JSON.parse(j.payload);
    return {
      id: j.id,
      type: j.type,
      device: j.device_name,
      client: j.client_name,
      label: payload.label,
      mode: payload.mode,
      fileCount: payload.files.length,
      status: j.status,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
      result: j.result ? JSON.parse(j.result) : null,
    };
  }

  const routes = {
    async "POST /login"({ body, ip, setSession }) {
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      if (recentFailures(`ip:${ip}`).length >= 10 || recentFailures(`user:${username.toLowerCase()}`).length >= 5) {
        store.audit(username || "?", "login.blocked", null, ip);
        throw new ApiError(429, "Too many failed attempts. Wait 15 minutes and try again.");
      }
      const admin = username ? store.adminByName(username) : null;
      const ok = admin ? await verifyPassword(password, admin.password_hash) : (await burnTime(password), false);
      if (!ok) {
        addFailure(`ip:${ip}`);
        addFailure(`user:${username.toLowerCase()}`);
        store.audit(username || "?", "login.failed", null, ip);
        log.warn(`Admin login failed for "${username}" from ${ip}`);
        throw new ApiError(401, "Wrong username or password.");
      }
      failures.delete(`user:${username.toLowerCase()}`);
      store.recordLogin(admin.id);
      setSession(admin.id);
      store.audit(admin.username, "login", null, ip);
      log.info(`Admin "${admin.username}" logged in from ${ip}`);
      return { username: admin.username };
    },

    "POST /logout"({ admin, ip, clearSession }) {
      clearSession();
      store.audit(admin.username, "logout", null, ip);
      return { ok: true };
    },

    "GET /me"({ admin }) {
      return { username: admin.username };
    },

    "GET /overview"() {
      const stats = store.versionStats();
      const devices = db.listDevices().map((d) => publicDevice(d, stats));
      const storageRows = db.storageStats();
      return {
        devices: {
          total: devices.length,
          online: devices.filter((d) => d.online).length,
          offline: devices.filter((d) => !d.online).length,
          frozen: devices.filter((d) => d.status === "frozen").length,
        },
        quarantined: db.listQuarantine(10000).length,
        openAlerts: db.openAlertCount(),
        files: stats.reduce((n, s) => n + s.paths, 0),
        versions: stats.reduce((n, s) => n + s.versions, 0),
        pendingChanges: devices.reduce((n, d) => n + (d.pendingChanges ?? 0), 0),
        storage: {
          originalBytes: storageRows.reduce((n, s) => n + s.plain, 0),
          storedBytes: storageRows.reduce((n, s) => n + s.stored, 0),
        },
        recentJobs: db.listCommands(5).map(publicJob),
        lastVerify: store.getSetting("lastVerify"),
        deviceList: devices,
      };
    },

    "GET /devices"() {
      const stats = store.versionStats();
      return db.listDevices().map((d) => publicDevice(d, stats));
    },

    "POST /enrollment-codes"({ body, admin, ip }) {
      try {
        const { code, clientName, expiresAt } = createEnrollmentCode(db, body.clientName, config.codeTtlMinutes);
        store.audit(admin.username, "enrollment-code.created", { clientName }, ip);
        return { code, clientName, expiresAt };
      } catch (err) {
        throw new ApiError(400, err.message);
      }
    },

    // Browse one folder level. With ?at= it shows the folder as it was at that moment.
    "GET /devices/:id/files"({ params, query }) {
      const device = getDeviceOr404(params.id);
      const folder = normalizePath(query.path);
      const at = query.at ? new Date(query.at) : null;
      if (at && Number.isNaN(at.getTime())) throw new ApiError(400, "Bad date");

      const latest = new Map();
      const counts = new Map();
      for (const row of db.versionsUnder(device.id, folder)) {
        if (at && new Date(row.received_at) > at) continue;
        latest.set(row.rel_path, row);
        counts.set(row.rel_path, (counts.get(row.rel_path) ?? 0) + 1);
      }

      const prefix = folder ? `${folder}/` : "";
      const folders = new Map();
      const files = [];
      for (const row of latest.values()) {
        if (folder && row.rel_path === folder) continue; // `folder` is actually a file
        const rest = row.rel_path.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          files.push({
            name: rest,
            path: row.rel_path,
            deleted: row.type === "deleted",
            versionNo: row.version_no,
            versionCount: counts.get(row.rel_path),
            size: row.size,
            backedUpAt: row.received_at,
          });
        } else {
          const name = rest.slice(0, slash);
          const f = folders.get(name) ?? { name, path: prefix + name, files: 0, size: 0, deletedFiles: 0 };
          if (row.type === "deleted") f.deletedFiles++;
          else {
            f.files++;
            f.size += row.size ?? 0;
          }
          folders.set(name, f);
        }
      }
      return {
        device: { id: device.id, name: device.device_name, client: device.client_name },
        path: folder,
        at: at?.toISOString() ?? null,
        folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      };
    },

    "GET /devices/:id/versions"({ params, query }) {
      const device = getDeviceOr404(params.id);
      const relPath = normalizePath(query.path);
      if (!relPath) throw new ApiError(400, "path is required");
      return {
        path: relPath,
        versions: store.versionsOfFile(device.id, relPath).map((v) => ({
          versionNo: v.version_no,
          type: v.type,
          size: v.size,
          sha256: v.sha256,
          backedUpAt: v.received_at,
          status: v.status,
          reasons: v.reasons ? JSON.parse(v.reasons).map((r) => REASON_TEXT[r] ?? r) : [],
        })),
      };
    },

    // Changes per time slot. A sudden spike of changes is what a ransomware attack looks like.
    "GET /devices/:id/activity"({ params, query }) {
      const device = getDeviceOr404(params.id);
      const hours = Math.min(Math.max(Number(query.hours) || 24, 1), 24 * 30);
      const bucketMin = Math.min(Math.max(Number(query.bucket) || 15, 1), 24 * 60);
      const bucketMs = bucketMin * 60 * 1000;
      const end = Date.now();
      const start = Math.floor((end - hours * 3600 * 1000) / bucketMs) * bucketMs;

      const buckets = [];
      for (let t = start; t <= end; t += bucketMs) {
        buckets.push({ start: new Date(t).toISOString(), added: 0, changed: 0, deleted: 0, quarantined: 0 });
      }
      const rows = store.activitySince(device.id, new Date(start).toISOString());
      for (const r of rows) {
        const i = Math.floor((new Date(r.received_at) - start) / bucketMs);
        if (!buckets[i]) continue;
        if (r.status === "ok") buckets[i][r.type]++;
        else buckets[i].quarantined++;
      }
      return {
        bucketMinutes: bucketMin,
        buckets,
        recent: rows.slice(-200).reverse().map((r) => ({
          path: r.rel_path,
          versionNo: r.version_no,
          type: r.type,
          size: r.size,
          at: r.received_at,
          status: r.status,
        })),
      };
    },

    "POST /restore/preview"({ body }) {
      try {
        const plan = prepareRestore(db, body, { create: false });
        return { ...plan, files: plan.files.slice(0, 500).map(({ chunkIds, ...f }) => f) };
      } catch (err) {
        if (err instanceof RestoreError) throw new ApiError(400, err.message);
        throw err;
      }
    },

    "POST /restore"({ body, admin, ip }) {
      try {
        const plan = prepareRestore(db, body, { create: true });
        store.audit(admin.username, "restore.created", {
          jobId: plan.jobId, label: plan.label, mode: plan.mode, target: plan.target.name, files: plan.fileCount,
        }, ip);
        log.info(`Admin "${admin.username}" created restore job #${plan.jobId}: ${plan.label} → ${plan.target.name}`);
        broker.wake(plan.target.id); // start right away instead of at the next heartbeat
        return { jobId: plan.jobId, label: plan.label, fileCount: plan.fileCount, totalSize: plan.totalSize };
      } catch (err) {
        if (err instanceof RestoreError) throw new ApiError(400, err.message);
        throw err;
      }
    },

    "GET /jobs"() {
      return db.listCommands(50).map(publicJob);
    },

    "POST /verify"({ admin, ip }) {
      const report = runVerify({ db, keys, storage });
      store.setSetting("lastVerify", report);
      store.audit(admin.username, "verify.run", { checked: report.checked, damaged: report.damaged }, ip);
      return report;
    },

    "GET /verify/last"() {
      return store.getSetting("lastVerify");
    },

    "GET /audit"() {
      return store.listAudit(200);
    },

    "GET /quarantine"() {
      return db.listQuarantine(500).map((v) => ({
        id: v.id,
        deviceId: v.device_id,
        device: v.device_name,
        client: v.client_name,
        path: v.rel_path,
        versionNo: v.version_no,
        type: v.type,
        size: v.size,
        entropy: v.entropy,
        reasons: v.reasons ? JSON.parse(v.reasons).map((r) => REASON_TEXT[r] ?? r) : [],
        receivedAt: v.received_at,
      }));
    },

    "POST /quarantine/release"({ body, admin, ip }) {
      return review(body, "ok", admin, ip);
    },

    "POST /quarantine/reject"({ body, admin, ip }) {
      return review(body, "rejected", admin, ip);
    },

    "POST /devices/:id/unfreeze"({ params, admin, ip }) {
      const device = getDeviceOr404(params.id);
      if (!device.frozen_at) throw new ApiError(400, "This device isn't frozen.");
      db.unfreezeDevice(device.id);
      store.audit(admin.username, "device.unfrozen", { device: device.device_name, reason: device.frozen_reason }, ip);
      log.info(`Admin "${admin.username}" unfroze ${device.device_name}`);
      return { ok: true };
    },

    "GET /alerts"() {
      return db.listAlerts(100).map((a) => ({
        id: a.id,
        kind: a.kind,
        message: a.message,
        device: a.device_name,
        deviceId: a.device_id,
        client: a.client_name,
        createdAt: a.created_at,
        acknowledgedAt: a.acknowledged_at,
        acknowledgedBy: a.acknowledged_by,
      }));
    },

    "POST /alerts/:id/ack"({ params, admin, ip }) {
      if (!db.ackAlert(Number(params.id), admin.username)) throw new ApiError(404, "Alert not found or already dismissed.");
      store.audit(admin.username, "alert.dismissed", { alertId: Number(params.id) }, ip);
      return { ok: true };
    },
  };

  function publicFolder(f) {
    return {
      id: f.id,
      name: f.name,
      path: f.path,
      excludes: JSON.parse(f.excludes),
      status: f.status,
      // What the device last said about it: ok / missing / denied, or null = not reported yet
      state: f.reported_at && f.reported_at >= f.added_at ? f.state : null,
      error: f.error,
      files: f.files,
      bytes: f.bytes,
      reportedAt: f.reported_at,
      addedAt: f.added_at,
      addedBy: f.added_by,
      removedAt: f.removed_at,
      removedBy: f.removed_by,
    };
  }

  function requireMultiFolder(device) {
    if ((device.path_layout ?? 1) < 2) {
      throw new ApiError(409, "This device's agent is too old to manage folders. Update it to version 0.7 or newer.");
    }
  }

  function foldersChanged(device, admin, ip, action, details) {
    db.bumpFoldersVersion(device.id);
    broker.wake(device.id);
    store.audit(admin.username, action, { device: device.device_name, ...details }, ip);
  }

  Object.assign(routes, {
    "GET /devices/:id/folders"({ params }) {
      const d = getDeviceOr404(params.id);
      return {
        device: { id: d.id, name: d.device_name, client: d.client_name, status: deviceStatus(d), live: broker.isLive(d.id) },
        multiFolder: (d.path_layout ?? 1) >= 2,
        platform: d.platform,
        allowedPaths: d.allowed_paths ? JSON.parse(d.allowed_paths) : [],
        folders: db.listFolders(d.id).map(publicFolder),
        settings: settingsOf(d),
        agentStatus: d.agent_status ? JSON.parse(d.agent_status) : null,
      };
    },

    // Background settings: priority, upload speed limits, work hours, pauses, scan mode
    "POST /devices/:id/settings"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      requireMultiFolder(d);
      let settings;
      try {
        settings = cleanSettings(body.settings);
      } catch (err) {
        if (err instanceof SettingsError) throw new ApiError(400, err.message);
        throw err;
      }
      const before = settingsOf(d);
      db.setDeviceSettings(d.id, settings);
      const changed = Object.keys(settings).filter((k) => JSON.stringify(settings[k]) !== JSON.stringify(before[k]));
      foldersChanged(d, admin, ip, "device.settings-changed", { changed });
      log.info(`Admin "${admin.username}" changed background settings on ${d.device_name}: ${changed.join(", ") || "no changes"}`);
      return { settings };
    },

    // Live folder browser: the agent lists the sub-folders of `path` (names only, no files).
    // Empty path = the device's allowed areas. The agent refuses anything outside them.
    async "POST /devices/:id/browse"({ params, body }) {
      const d = getDeviceOr404(params.id);
      requireMultiFolder(d);
      if (!broker.isLive(d.id)) throw new ApiError(409, "This device isn't connected right now, so its folders can't be browsed.");
      const path = String(body.path ?? "");
      if (path && !isValidDevicePath(path)) throw new ApiError(400, "Bad path");
      const result = await broker.requestBrowse(d.id, path);
      if (result.error) throw new ApiError(400, result.error);
      const { id, ...listing } = result;
      return listing;
    },

    "POST /devices/:id/folders"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      requireMultiFolder(d);
      const path = String(body.path ?? "").trim();
      if (!isValidDevicePath(path)) throw new ApiError(400, "Pick a folder on the device.");
      let excludes;
      try {
        excludes = cleanExcludes(body.excludes);
      } catch (err) {
        throw new ApiError(400, err.message);
      }

      // The device enforces its allowed areas itself; checking here too gives a clear message up front
      const allowed = d.allowed_paths ? JSON.parse(d.allowed_paths) : [];
      if (allowed.length && !allowed.some((a) => isInsidePath(path, a, d.platform))) {
        throw new ApiError(400, "That folder is outside the allowed areas set on this device.");
      }

      const all = db.listFolders(d.id);
      const active = all.filter((f) => f.status === "active");
      const clash = active.find((f) => foldersOverlap(f.path, path, d.platform));
      if (clash) {
        throw new ApiError(400, samePath(clash.path, path, d.platform)
          ? `This folder is already backed up as "${clash.name}".`
          : `This folder overlaps "${clash.name}" (${clash.path}). A file can only be in one backup folder.`);
      }
      if (active.length >= MAX_FOLDERS) throw new ApiError(400, `A device can have at most ${MAX_FOLDERS} backup folders.`);

      // Added back after being removed: same name, so its history continues
      const previous = all.find((f) => f.status === "removed" && samePath(f.path, path, d.platform));
      if (previous) {
        db.reactivateFolder(previous.id, { excludes, by: admin.username });
        foldersChanged(d, admin, ip, "folder.added", { name: previous.name, path, readded: true });
        log.info(`Admin "${admin.username}" added back folder "${previous.name}" on ${d.device_name}`);
        return publicFolder(db.getFolder(previous.id));
      }

      // Names must be unique per device (they're the top level of every backed-up path)
      const base = folderNameFromPath(path);
      const taken = new Set(all.map((f) => f.name.toLowerCase()));
      let name = base;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;

      const id = newFolderId();
      db.addFolder(d.id, { id, name, path, excludes, by: admin.username });
      foldersChanged(d, admin, ip, "folder.added", { name, path });
      log.info(`Admin "${admin.username}" added backup folder "${name}" (${path}) on ${d.device_name}`);
      return publicFolder(db.getFolder(id));
    },

    "POST /devices/:id/folders/:folderId/excludes"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      const f = db.getFolder(params.folderId);
      if (!f || f.device_id !== d.id || f.status !== "active") throw new ApiError(404, "Folder not found");
      let excludes;
      try {
        excludes = cleanExcludes(body.excludes);
      } catch (err) {
        throw new ApiError(400, err.message);
      }
      db.setFolderExcludes(f.id, excludes);
      foldersChanged(d, admin, ip, "folder.excludes-changed", { name: f.name, excludes });
      return publicFolder(db.getFolder(f.id));
    },

    // Stops backing the folder up. Its backups are KEPT: still browsable and restorable,
    // and it can be added back later with its history intact.
    "POST /devices/:id/folders/:folderId/remove"({ params, admin, ip }) {
      const d = getDeviceOr404(params.id);
      const f = db.getFolder(params.folderId);
      if (!f || f.device_id !== d.id) throw new ApiError(404, "Folder not found");
      if (!db.removeFolder(f.id, admin.username)) throw new ApiError(400, "This folder was already removed.");
      foldersChanged(d, admin, ip, "folder.removed", { name: f.name, path: f.path });
      log.info(`Admin "${admin.username}" removed backup folder "${f.name}" on ${d.device_name} (backups kept)`);
      return { ok: true };
    },
  });

  // Release (status "ok") or reject quarantined versions
  function review(body, status, admin, ip) {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, 1000) : [];
    if (!ids.length) throw new ApiError(400, "No items selected.");
    let changed = 0;
    for (const id of ids) if (db.reviewVersion(id, status, admin.username)) changed++;
    const action = status === "ok" ? "quarantine.released" : "quarantine.rejected";
    store.audit(admin.username, action, { count: changed }, ip);
    log.info(`Admin "${admin.username}" ${status === "ok" ? "released" : "rejected"} ${changed} quarantined version(s)`);
    return { changed };
  }

  // Turn "GET /devices/:id/files" patterns into matchers
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ");
    const names = [];
    const re = new RegExp(
      "^" + pattern.replace(/:[a-zA-Z]+/g, (m) => (names.push(m.slice(1)), "([A-Za-z0-9_-]+)")) + "$"
    );
    return { method, re, names, handler, isLogin: pattern === "/login" };
  });

  return function match(method, pathname) {
    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (m) return { handler: r.handler, isLogin: r.isLogin, params: Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]])) };
    }
    return null;
  };
}