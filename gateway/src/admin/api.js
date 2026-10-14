// The admin API used by the web UI. Every route except /login requires a valid session.
//
//   POST /admin/api/login                     { username, password }
//   POST /admin/api/logout
//   GET  /admin/api/me
//   GET  /admin/api/overview                  dashboard numbers
//   GET  /admin/api/devices
//   POST /admin/api/enrollment-codes          { clientName, platform?, allowed?, deviceName?, watch? }
//                                             -> one-time code (shown once) + one-line install command
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
//   GET  /admin/api/quarantine/:id/inspect     safe preview of a held file + its last good version
//   POST /admin/api/quarantine/release         { ids } → become normal versions
//   POST /admin/api/quarantine/reject          { ids } → kept as evidence, never restorable
//   POST /admin/api/devices/:id/unfreeze       resume normal backups for a frozen device
//   GET  /admin/api/alerts
//   POST /admin/api/alerts/:id/ack
//   GET  /admin/api/devices/:id/folders                     backup folders + the device's allowed areas
//   POST /admin/api/devices/:id/browse                      { path } list folders on the device (live)
//   POST /admin/api/devices/:id/lock                        { action: lock|unlock|remove, key? } folder lock
//   POST /admin/api/devices/:id/folders                     { path, excludes } start backing up a folder
//   POST /admin/api/devices/:id/folders/:folderId/excludes  { excludes }
//   POST /admin/api/devices/:id/folders/:folderId/remove    stop backing it up (backups are kept)
//   POST /admin/api/devices/:id/settings                    background settings (speed limits, pauses...)
//   GET  /admin/api/cloud                      off-site copy: settings and progress
//   POST /admin/api/cloud/test                 { settings } check them without saving
//   POST /admin/api/cloud/connect              { settings } -> recovery key (shown once)
//   POST /admin/api/cloud/key                  { keyId, secret } replace the access key
//   POST /admin/api/cloud/pause                { paused }
//   POST /admin/api/cloud/sync                 check everything and upload now
//   POST /admin/api/cloud/disconnect           { bucket } stop sending (nothing in the bucket is touched)
//   Security page: security-api.js. Agent updates: updates-api.js. Alerts page: notify-api.js.
//   Pause, uninstall or remove a device: service-api.js.

import { createEnrollmentCode } from "../codes.js";
import { normalizePath, prepareRestore, RestoreError } from "../restore-plan.js";
import { runVerify } from "../verify.js";
import { verifyPassword, burnTime } from "./passwords.js";
import { createLoginGuard } from "./login-guard.js";
import { ALLOWED_IN_LOCKDOWN } from "./lockdown.js";
import { newSecret, verifyCode, otpauthUrl, newRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode } from "./totp.js";
import { REASON_TEXT, describeContent, isText } from "../inspect.js";
import { cleanInstallOptions } from "../installs.js";
import { chunkId as makeChunkId, open } from "../crypto-box.js";
import {
  MAX_FOLDERS, cleanExcludes, folderNameFromPath, foldersOverlap, isInsidePath, isValidDevicePath, newFolderId, samePath,
} from "../folders.js";
import { SettingsError, cleanSettings, settingsOf } from "../device-settings.js";
import { CloudError, cleanCloudSettings, testCloud, PROVIDERS } from "../cloud/offsite.js";
import { CopyError } from "../cloud/copies.js";
import { startSignIn, finishSignIn, explainDrive, createDrive } from "../cloud/gdrive.js";
import { cleanDestinations } from "../cloud/routing.js";
import { securityRoutes } from "./security-api.js";
import { updatesRoutes } from "./updates-api.js";
import { notifyRoutes } from "./notify-api.js";
import { serviceRoutes } from "./service-api.js";
import { addressRoutes } from "./address-api.js";
import { log } from "../logger.js";
import crypto from "node:crypto";

const ONLINE_WINDOW_MS = 90_000; // seen within 90 s (3 missed heartbeats) = online

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deviceStatus(device) {
  if (device.status !== "active") return device.status;
  if (device.frozen_at) return "frozen";
  if (!device.last_seen_at) return "never-seen";
  return Date.now() - new Date(device.last_seen_at) < ONLINE_WINDOW_MS ? "online" : "offline";
}

export function createAdminApi({ db, store, keys, storage, config, broker, installs, copies, security, scanner, updates, notify, health, removals, address, lockdown = null }) {
  // Wrong passwords: slowed down and blocked per address; an attack turns on lockdown (login-guard.js)
  const guard = createLoginGuard({
    onAttack(reason) {
      log.warn(`Login attack: ${reason}`);
      security?.event("critical", "admin.login-attack", `The web UI login is under attack: ${reason}`, { detail: { reason } });
      lockdown?.turnOn(`login attack (${reason})`, "gateway");
    },
  });
  // Two-factor setup waiting for its first code (10 minutes at most): adminId -> { secret, expires }
  const pendingTwoFactor = new Map();
  const twoFactorOf = (admin) => {
    const a = store.adminById(admin.id);
    return { on: !!a?.totp_secret, recoveryCodesLeft: a?.recovery_codes ? JSON.parse(a.recovery_codes).length : 0, row: a };
  };
  async function checkPassword(admin, password) {
    const a = store.adminById(admin.id);
    if (!a || !(await verifyPassword(String(password ?? ""), a.password_hash))) throw new ApiError(403, "Wrong password.");
    return a;
  }
  // A code from the authenticator app, or one of the recovery codes (used up). Returns how, or null.
  function useCode(a, code) {
    if (!a?.totp_secret) return null;
    const step = verifyCode(a.totp_secret, code, a.totp_last);
    if (step !== null) {
      store.setTotpLast(a.id, step);
      return "app";
    }
    if (looksLikeRecoveryCode(code)) {
      const left = JSON.parse(a.recovery_codes ?? "[]");
      const h = hashRecoveryCode(code);
      if (left.includes(h)) {
        store.setRecoveryCodes(a.id, left.filter((x) => x !== h));
        return "recovery code";
      }
    }
    return null;
  }

  const listingCache = new Map(); // folder listings, see GET /devices/:id/files
  function publicDevice(d, stats, storageRows = db.storageStats()) {
    const s = stats?.find((x) => x.device_id === d.id);
    const storageRow = storageRows.find((x) => x.device_id === d.id);
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
      removedAt: d.status !== "active" ? removals?.get(d.id)?.finished_at ?? null : null,
      uninstalled: d.status !== "active" && removals?.get(d.id)?.state === "done",
      autoDelete: d.status !== "active" && removals ? removals.autoDeleteOf(d.id) : null,
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
      const why = guard.blocked(ip, username);
      if (why) {
        store.audit(username || "?", "login.blocked", null, ip);
        security?.event("high", "admin.login-blocked", `Logins blocked for "${username || "?"}" from ${ip} after repeated wrong tries`, { detail: { username, ip } });
        throw new ApiError(429, why);
      }
      const admin = username ? store.adminByName(username) : null;
      const ok = admin ? await verifyPassword(password, admin.password_hash) : (await burnTime(password), false);
      const failed = async (what, message) => {
        await sleep(guard.delayMs(ip));
        guard.failed(ip, username);
        store.audit(username || "?", what, null, ip);
        security?.event("medium", "admin.login-failed", `${message} for "${username || "?"}" from ${ip}`, { detail: { username, ip } });
        log.warn(`Admin login failed (${message.toLowerCase()}) for "${username}" from ${ip}`);
      };
      if (!ok) {
        await failed("login.failed", "Wrong password");
        throw new ApiError(401, "Wrong username or password.");
      }
      // Two-factor login: the password was right, now the code
      let via = null;
      if (admin.totp_secret) {
        if (!String(body.code ?? "").trim()) return { needsCode: true };
        via = useCode(admin, body.code);
        if (!via) {
          await failed("login.failed-code", "Wrong two-factor code");
          throw new ApiError(401, "That code isn't right. Codes change every 30 seconds, and each one works once.");
        }
      }
      guard.succeeded(ip, username);
      store.recordLogin(admin.id);
      setSession(admin.id);
      store.audit(admin.username, "login", via ? { twoFactor: via } : null, ip);
      if (via === "recovery code") {
        security?.event("high", "admin.recovery-code", `${admin.username} signed in with a recovery code from ${ip}`, { detail: { username: admin.username, ip } });
      }
      log.info(`Admin "${admin.username}" logged in from ${ip}${via ? ` (two-factor: ${via})` : ""}`);
      return { username: admin.username, twoFactor: !!admin.totp_secret, lockdown: !!lockdown?.isOn() };
    },

    "POST /logout"({ admin, ip, clearSession }) {
      clearSession();
      store.audit(admin.username, "logout", null, ip);
      return { ok: true };
    },

    "GET /me"({ admin }) {
      const tf = twoFactorOf(admin);
      return { username: admin.username, twoFactor: tf.on, recoveryCodesLeft: tf.recoveryCodesLeft, lockdown: !!lockdown?.isOn() };
    },

    // ----- Two-factor login (totp.js) -----
    async "POST /me/2fa/start"({ admin, body }) {
      await checkPassword(admin, body.password);
      if (twoFactorOf(admin).on) throw new ApiError(409, "Two-factor login is already on.");
      const secret = newSecret();
      pendingTwoFactor.set(admin.id, { secret, expires: Date.now() + 10 * 60_000 });
      return { secret, otpauth: otpauthUrl(secret, admin.username) };
    },
    "POST /me/2fa/confirm"({ admin, body, ip }) {
      const p = pendingTwoFactor.get(admin.id);
      if (!p || p.expires < Date.now()) throw new ApiError(410, "That setup expired. Start again.");
      const step = verifyCode(p.secret, body.code);
      if (step === null) throw new ApiError(400, "That code isn't right. Check the phone's clock is set automatically, and type the newest code.");
      const codes = newRecoveryCodes();
      store.setTwoFactor(admin.id, p.secret, codes.map(hashRecoveryCode));
      store.setTotpLast(admin.id, step);
      pendingTwoFactor.delete(admin.id);
      store.audit(admin.username, "2fa.on", null, ip);
      security?.event("info", "admin.2fa", `${admin.username} turned on two-factor login`, { detail: { username: admin.username } });
      return { recoveryCodes: codes };
    },
    async "POST /me/2fa/recovery-codes"({ admin, body, ip }) {
      const a = await checkPassword(admin, body.password);
      if (!a.totp_secret) throw new ApiError(409, "Two-factor login is off.");
      if (!useCode(a, body.code)) throw new ApiError(400, "That code isn't right.");
      const codes = newRecoveryCodes();
      store.setRecoveryCodes(a.id, codes.map(hashRecoveryCode));
      store.audit(admin.username, "2fa.new-recovery-codes", null, ip);
      return { recoveryCodes: codes };
    },
    async "POST /me/2fa/disable"({ admin, body, ip }) {
      const a = await checkPassword(admin, body.password);
      if (!a.totp_secret) return { ok: true };
      if (!useCode(a, body.code)) throw new ApiError(400, "That code isn't right.");
      store.setTwoFactor(a.id, null, null);
      store.audit(admin.username, "2fa.off", null, ip);
      security?.event("high", "admin.2fa", `${admin.username} turned off two-factor login`, { detail: { username: admin.username, ip } });
      return { ok: true };
    },

    // ----- Lockdown (lockdown.js) -----
    "GET /lockdown"() {
      return lockdown ? lockdown.view() : { on: false, liftWithKey: false };
    },
    "POST /lockdown"({ admin, body, ip }) {
      if (!lockdown) throw new ApiError(404, "Not available");
      lockdown.turnOn(String(body.reason ?? "").trim().slice(0, 200) || "turned on by hand", admin.username, ip);
      return lockdown.view();
    },
    "POST /lockdown/lift"({ admin, body, ip }) {
      if (!lockdown) throw new ApiError(404, "Not available");
      try {
        lockdown.lift(body.recoveryKey, admin.username, ip);
      } catch (err) {
        throw new ApiError(400, err.message);
      }
      return lockdown.view();
    },

    "GET /overview"() {
      const stats = db.versionStats();
      const storageRows = db.storageStats();
      // Last 24 hours of changes per device, in 2-hour slots, for the activity bars on each device card
      const SLOT_MS = 2 * 3600 * 1000;
      const start = Date.now() - 12 * SLOT_MS;
      // Removed devices aren't part of the dashboard (they're listed on the Devices page)
      const devices = db.listDevices().filter((d) => d.status === "active").map((d) => {
        const activity = Array.from({ length: 12 }, () => ({ ok: 0, held: 0 }));
        for (const r of store.activitySince(d.id, new Date(start).toISOString())) {
          const slot = activity[Math.min(11, Math.floor((new Date(r.received_at) - start) / SLOT_MS))];
          if (slot) r.status === "ok" ? slot.ok++ : slot.held++;
        }
        return { ...publicDevice(d, stats, storageRows), activity };
      });
      return {
        devices: {
          total: devices.length,
          online: devices.filter((d) => d.online).length,
          offline: devices.filter((d) => !d.online).length,
          frozen: devices.filter((d) => d.status === "frozen").length,
        },
        quarantined: db.quarantineCount(),
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
      const stats = db.versionStats();
      const storageRows = db.storageStats();
      return db.listDevices().map((d) => publicDevice(d, stats, storageRows));
    },

    // With a platform: also makes a one-line install command that carries the code and settings
    "POST /enrollment-codes"({ body, admin, ip }) {
      try {
        const options = body.platform ? cleanInstallOptions(body) : null;
        if (options && !installs?.available) {
          throw new ApiError(409, "One-line installs are off: the gateway can't find the agent folder (see its log).");
        }
        const { code, clientName, expiresAt } = createEnrollmentCode(db, body.clientName, config.codeTtlMinutes);
        const install = options ? installs.create({ code, clientName, expiresAt, options }) : null;
        store.audit(admin.username, options ? "install-link.created" : "enrollment-code.created", { clientName, platform: options?.platform }, ip);
        return { code, clientName, expiresAt, install };
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(400, err.message);
      }
    },

    // Browse one folder level. With ?at= it shows the folder as it was at that moment.
    "GET /devices/:id/files"({ params, query }) {
      const device = getDeviceOr404(params.id);
      const folder = normalizePath(query.path);
      const at = query.at ? new Date(query.at) : null;
      if (at && Number.isNaN(at.getTime())) throw new ApiError(400, "Bad date");

      // Counted by the database, one row per file or sub-folder at this level. Big folders take a
      // moment to count, so the answer is kept until the device sends a new version or a quarantined
      // file is released or rejected.
      const stamp = `${db.versionStats().find((x) => x.device_id === device.id)?.versions ?? 0}|${db.quarantineCount()}|${device.path_layout}`;
      const cacheKey = `${device.id}|${folder}|${at?.toISOString() ?? ""}`;
      const cached = listingCache.get(cacheKey);
      if (cached?.stamp === stamp) return cached.result;

      const folders = [];
      const files = [];
      for (const row of db.listFolder(device.id, folder, at?.toISOString())) {
        if (row.is_folder) {
          folders.push({
            name: row.name,
            path: folder ? `${folder}/${row.name}` : row.name,
            files: row.files,
            size: row.total_size,
            deletedFiles: row.deleted_files,
          });
        } else {
          files.push({
            name: row.name,
            path: row.rel_path,
            deleted: row.type === "deleted",
            versionNo: row.version_no,
            versionCount: row.version_count,
            size: row.size,
            backedUpAt: row.received_at,
          });
        }
      }
      const result = {
        device: { id: device.id, name: device.device_name, client: device.client_name },
        path: folder,
        at: at?.toISOString() ?? null,
        folders: folders.sort((a, b) => a.name.localeCompare(b.name)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      };
      listingCache.delete(cacheKey);
      listingCache.set(cacheKey, { stamp, result });
      if (listingCache.size > 100) listingCache.delete(listingCache.keys().next().value); // oldest first
      return result;
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
        malware: v.scan_status === "infected" ? v.scan_signature : null,
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
      security?.event("medium", "device.unfrozen", `${admin.username} unfroze ${device.device_name}`, { deviceId: device.id, detail: { by: admin.username, reason: device.frozen_reason } });
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
      // Which off-site copies get this folder: null = all of them
      destinations: f.destinations ? JSON.parse(f.destinations) : null,
    };
  }

  const agentStatusOf = (d) => (d.agent_status ? JSON.parse(d.agent_status) : null);

  // The device enforces the lock itself; refusing here too gives a clear message up front
  function requireUnlocked(device) {
    if (agentStatusOf(device)?.lock?.locked) {
      throw new ApiError(423, "The backup folders are locked on this device. Unlock them with the unlock key first.");
    }
  }

  // A new unlock key: BGFL- and 20 letters/digits (100 bits), shown once and never stored here
  function newLockKey() {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const bytes = crypto.randomBytes(20);
    const chars = [...bytes].map((b) => alphabet[b & 31]).join("");
    return `BGFL-${chars.match(/.{4}/g).join("-")}`;
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
        device: {
          id: d.id, name: d.device_name, client: d.client_name, status: deviceStatus(d), live: broker.isLive(d.id),
          agentVersion: d.agent_version,
        },
        multiFolder: (d.path_layout ?? 1) >= 2,
        platform: d.platform,
        allowedPaths: d.allowed_paths ? JSON.parse(d.allowed_paths) : [],
        folders: db.listFolders(d.id).map(publicFolder),
        settings: settingsOf(d),
        agentStatus: agentStatusOf(d),
        // This device's own off-site copies, and whether the failsafe (everything) is set up
        offsite: {
          copies: copies.forDevice(d.id),
          failsafe: !!copies.failsafe(),
          google: googlePublic(),
        },
      };
    },

    // Folder lock. The device checks the key; this gateway never keeps it. "lock" the first time
    // makes the key and returns it once; after an unlock, "lock" locks again with the same key.
    async "POST /devices/:id/lock"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      requireMultiFolder(d);
      if (!broker.isLive(d.id)) throw new ApiError(409, "The device must be connected to lock or unlock its folders.");
      const action = String(body.action ?? "");
      if (!["lock", "unlock", "remove"].includes(action)) throw new ApiError(400, "Unknown action");
      const status = agentStatusOf(d);

      let key = null;
      let newKey = null;
      if (action === "lock") {
        if (!status?.lock?.enabled) key = newKey = newLockKey();
      } else {
        key = String(body.key ?? "").trim();
        if (!key || key.length > 64) throw new ApiError(400, "Enter the unlock key.");
      }

      const result = await broker.requestAgent(d.id, { action, ...(key ? { key } : {}) }, 30_000);
      if (result.error) {
        if (action !== "lock") store.audit(admin.username, "folders.unlock-failed", { device: d.device_name, action }, ip);
        throw new ApiError(400, result.error);
      }
      if (!result.lock) throw new ApiError(502, "The device didn't confirm. Is its agent up to date (0.13 or newer)?");

      // Show the new state straight away (the next heartbeat confirms it)
      db.setAgentStatus(d.id, { ...(status ?? {}), lock: result.lock });
      const what = { lock: newKey ? "folders.locked-new-key" : "folders.locked", unlock: "folders.unlocked", remove: "folders.lock-removed" }[action];
      store.audit(admin.username, what, { device: d.device_name }, ip);
      log.info(`Admin "${admin.username}": ${what} on ${d.device_name}`);
      return { lock: result.lock, ...(newKey ? { key: newKey } : {}) };
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
      requireUnlocked(d);
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
      if (!agentStatusOf(d)?.fullAccess && allowed.length && !allowed.some((a) => isInsidePath(path, a, d.platform))) {
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
      requireUnlocked(d);
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

    // Which off-site copies this folder goes to (Backblaze/S3, Google Drive, or both)
    "POST /devices/:id/folders/:folderId/destinations"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      const f = db.getFolder(params.folderId);
      if (!f || f.device_id !== d.id) throw new ApiError(404, "Folder not found");
      let destinations;
      try {
        destinations = cleanDestinations(body.destinations, copies.forDevice(d.id).map((c) => c.id));
      } catch (err) {
        throw new ApiError(400, err.message);
      }
      db.setFolderDestinations(f.id, destinations);
      store.audit(admin.username, "folder.destinations-changed", { device: d.device_name, name: f.name, destinations: destinations ?? "all" }, ip);
      for (const c of copies.forDevice(d.id)) copies.syncNow(c.id); // look at this folder's backups again
      return publicFolder(db.getFolder(f.id));
    },

    // Stops backing the folder up. Its backups are KEPT: still browsable and restorable,
    // and it can be added back later with its history intact.
    "POST /devices/:id/folders/:folderId/remove"({ params, admin, ip }) {
      const d = getDeviceOr404(params.id);
      requireUnlocked(d);
      const f = db.getFolder(params.folderId);
      if (!f || f.device_id !== d.id) throw new ApiError(404, "Folder not found");
      if (!db.removeFolder(f.id, admin.username)) throw new ApiError(400, "This folder was already removed.");
      foldersChanged(d, admin, ip, "folder.removed", { name: f.name, path: f.path });
      log.info(`Admin "${admin.username}" removed backup folder "${f.name}" on ${d.device_name} (backups kept)`);
      return { ok: true };
    },
  });

  // First bytes of a stored file version, decrypted in memory only (never written anywhere)
  const PREVIEW_BYTES = 64 * 1024;
  function readStart(device, version, bytes) {
    const ids = version.chunk_ids ? JSON.parse(version.chunk_ids) : [];
    if (!ids.length) return Buffer.alloc(0);
    const k = keys.forDevice(device);
    if (!k) throw new ApiError(409, "This device's encryption keys aren't set up.");
    const parts = [];
    let have = 0;
    for (const id of ids) {
      let plain;
      try {
        plain = open(k.encKey, storage.readChunk(device.id, id), `chunk:${id}`);
        if (makeChunkId(k.idKey, plain) !== id) throw new Error("mismatch");
      } catch {
        throw new ApiError(500, "A stored chunk of this file is damaged or missing. Run an integrity check.");
      }
      parts.push(plain);
      have += plain.length;
      if (have >= bytes) break;
    }
    return Buffer.concat(parts).subarray(0, bytes);
  }

  function summary(device, v) {
    if (!v) return null;
    const isDeleted = v.type === "deleted";
    const sample = isDeleted ? Buffer.alloc(0) : readStart(device, v, PREVIEW_BYTES);
    return {
      versionNo: v.version_no,
      type: v.type,
      status: v.status,
      size: v.size,
      sha256: v.sha256,
      entropy: v.entropy,
      receivedAt: v.received_at,
      reasons: v.reasons ? JSON.parse(v.reasons).map((r) => REASON_TEXT[r] ?? r) : [],
      malware: v.scan_status === "infected" ? v.scan_signature : null,
      contentType: isDeleted ? "Deleted" : describeContent(sample, v.size),
      sample,
    };
  }

  // Shown as plain characters or a hex dump. Nothing in the file is opened, rendered or run.
  function previewOf(sample, size) {
    if (!sample.length) return null;
    if (isText(sample)) {
      return { kind: "text", text: sample.toString("utf8").replace(/\uFFFD+$/, ""), truncated: size > sample.length };
    }
    const hexBytes = sample.subarray(0, 4096);
    const lines = [];
    for (let i = 0; i < hexBytes.length; i += 16) {
      const row = hexBytes.subarray(i, i + 16);
      const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      const ascii = [...row].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
    }
    return { kind: "hex", text: lines.join("\n"), truncated: size > hexBytes.length };
  }

  // ---------- Off-site copies ----------
  // The failsafe (everything, one place) and each device's own copies (see cloud/copies.js).

  function cloudSettings(body) {
    try {
      return cleanCloudSettings(body ?? {});
    } catch (err) {
      if (err instanceof CloudError) throw new ApiError(400, err.message);
      throw err;
    }
  }
  async function cloudTest(settings) {
    try {
      await testCloud(settings);
    } catch (err) {
      if (err instanceof CloudError) throw new ApiError(400, err.message);
      throw err;
    }
  }
  function copyOr404(id) {
    const c = copies.get(id);
    if (!c) throw new ApiError(404, "That off-site copy isn't connected.");
    return c;
  }
  // deviceId in a request: a device's own copy; none: the failsafe
  function scopeOf(body) {
    if (!body.deviceId) return null;
    return getDeviceOr404(String(body.deviceId)).id;
  }
  const where = (c) => (c.deviceName ? `${c.client} / ${c.deviceName}` : "failsafe");

  // Signing in to Google happens in the browser: POST /cloud/drive/start gives the Google address,
  // and Google sends the person back to /admin/oauth/google on this gateway (oauthCallback below).
  const signIns = new Map(); // state -> { verifier, clientId, clientSecret, redirectUri, admin, deviceId, resign, back, expires }
  // Google sends the browser back to this gateway's own loopback address (a "desktop app"
  // sign-in): the address the browser is using now if it's a loopback one
  // On the gateway's domain (a cloud server): back to https://<domain>, for a "Web application" client
  function redirectUriFor(host) {
    const h = String(host ?? "");
    const live = address?.liveDomain?.();
    if (live && h.toLowerCase().replace(/:443$/, "") === live) return `https://${live}/admin/oauth/google`;
    const loopback = /^(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/.test(h) ? h.replace(/^localhost/, "127.0.0.1") : `127.0.0.1:${config.adminPort}`;
    return `http://${loopback}/admin/oauth/google`;
  }
  // The Google sign-in setup (made once in Google Cloud), as the web UI may see it: never the secret
  function googlePublic(host) {
    const g = copies.googleClient();
    return {
      configured: !!(g?.clientId && g?.clientSecret),
      clientId: g?.clientId ?? null,
      apiKey: g?.apiKey ?? null,
      projectNumber: g?.projectNumber ?? null,
      picker: !!(g?.apiKey && g?.projectNumber), // picking a folder already in the Drive
      redirectUri: redirectUriFor(host),
    };
  }
  // Signed in to Google, waiting for the person to choose the folder (30 minutes at most).
  // The sign-in stays in memory only, until the folder is chosen.
  const pendingDrives = new Map(); // id -> { sign, deviceId, admin, email, expires }
  function pendingOr404(id) {
    for (const [k, v] of pendingDrives) if (v.expires < Date.now()) pendingDrives.delete(k);
    const p = pendingDrives.get(String(id));
    if (!p) throw new ApiError(404, "That Google sign-in expired. Sign in again.");
    return p;
  }

  Object.assign(routes, {
    "GET /cloud"({ host }) {
      return {
        recoveryFingerprint: copies.recovery()?.fingerprint ?? null,
        failsafe: copies.failsafe(),
        copies: copies.list().filter((c) => !c.failsafe),
        providers: Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label }])),
        google: googlePublic(host),
      };
    },

    async "POST /cloud/test"({ body }) {
      await cloudTest(cloudSettings(body.settings));
      return { ok: true };
    },

    // A Backblaze/S3 bucket: the failsafe, or (with deviceId) one device's own
    async "POST /cloud/connect"({ body, admin, ip }) {
      const deviceId = scopeOf(body);
      const settings = cloudSettings(body.settings);
      await cloudTest(settings);
      let result;
      try {
        result = copies.addS3(settings, deviceId, admin.username);
      } catch (err) {
        if (err instanceof CopyError) throw new ApiError(409, err.message);
        throw err;
      }
      const c = copies.get(result.id);
      store.audit(admin.username, "cloud.connected", {
        for: where(c), provider: settings.provider, endpoint: settings.endpoint, bucket: settings.bucket,
        lockMode: settings.lockMode, retentionDays: settings.retentionDays, recoveryKey: result.fingerprint,
      }, ip);
      return result;
    },

    // The Google sign-in setup, made once in Google Cloud (see the Off-site page). Leave the
    // secret empty to keep the saved one.
    "POST /cloud/google"({ body, admin, ip, host }) {
      const known = copies.googleClient();
      const clientId = String(body.clientId ?? "").trim();
      const secretTyped = String(body.clientSecret ?? "").trim();
      const clientSecret = secretTyped || (clientId === known?.clientId ? known?.clientSecret : "");
      const apiKey = String(body.apiKey ?? "").trim() || null;
      const projectNumber = String(body.projectNumber ?? "").trim() || null;
      if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new ApiError(400, "Enter the client ID. It ends with .apps.googleusercontent.com");
      if (!clientSecret || clientSecret.length > 200 || /\s/.test(clientSecret)) throw new ApiError(400, "Enter the client secret.");
      if (apiKey && !/^[\w-]{20,100}$/.test(apiKey)) throw new ApiError(400, "That doesn't look like an API key (it starts with AIza).");
      if (projectNumber && !/^\d{5,20}$/.test(projectNumber)) throw new ApiError(400, "The project number is digits only (not the project ID).");
      copies.setGoogleClient({ clientId, clientSecret, apiKey, projectNumber });
      store.audit(admin.username, "cloud.google-setup-saved", { clientId, picker: !!(apiKey && projectNumber) }, ip);
      return googlePublic(host);
    },

    // Google Drive: returns the Google sign-in address to send the browser to
    "POST /cloud/drive/start"({ body, admin, host }) {
      const deviceId = scopeOf(body);
      const resign = body.resign ? copyOr404(String(body.resign)) : null;
      if (resign && resign.kind !== "drive") throw new ApiError(400, "That copy isn't a Google Drive.");
      const g = copies.googleClient();
      if (!g?.clientId || !g?.clientSecret) throw new ApiError(409, "Set up Google sign-in first, on the Off-site page (once).");
      if (!deviceId && !resign && copies.failsafe()) throw new ApiError(409, "There's already a failsafe copy. Disconnect it first to switch.");
      const redirectUri = redirectUriFor(host);
      const { url, state, verifier } = startSignIn({ clientId: g.clientId, redirectUri });
      for (const [k, v] of signIns) if (v.expires < Date.now()) signIns.delete(k);
      const owner = resign?.deviceId ?? deviceId;
      signIns.set(state, {
        verifier, clientId: g.clientId, clientSecret: g.clientSecret, redirectUri, admin: admin.username, deviceId, resign: resign?.id ?? null,
        back: owner ? `/devices/${owner}` : "/offsite", expires: Date.now() + 10 * 60_000,
      });
      return { url };
    },

    // After signing in: who it is, and what the folder chooser needs
    "GET /cloud/drive/pending/:id"({ params }) {
      const p = pendingOr404(params.id);
      return { email: p.email, deviceId: p.deviceId, defaultName: copies.defaultFolderName(p.deviceId), picker: googlePublic().picker };
    },

    // For the Google folder picker window: a short-lived token that can only reach files the
    // gateway made or the person picks (drive.file)
    async "POST /cloud/drive/pending/:id/picker"({ params }) {
      const p = pendingOr404(params.id);
      const g = copies.googleClient();
      if (!g?.apiKey || !g?.projectNumber) throw new ApiError(409, "Add the API key and project number in the Google sign-in setup to pick folders.");
      try {
        return { accessToken: await createDrive(p.sign).token(), apiKey: g.apiKey, appId: g.projectNumber };
      } catch (err) {
        throw new ApiError(502, explainDrive(err));
      }
    },

    // The folder is chosen: a new one ({ name, parentId? }) or one already there ({ folderId })
    async "POST /cloud/drive/pending/:id/finish"({ params, body, ip }) {
      const p = pendingOr404(params.id);
      const place = body.folderId ? { folderId: String(body.folderId) } : { name: body.name, parentId: body.parentId ? String(body.parentId) : null };
      let result;
      try {
        result = await copies.addDrive(p.sign, p.deviceId, p.admin, place);
      } catch (err) {
        if (err instanceof CopyError) throw new ApiError(409, err.message);
        throw new ApiError(502, explainDrive(err));
      }
      pendingDrives.delete(String(params.id));
      const c = copies.get(result.id);
      store.audit(p.admin, "cloud.connected", { for: where(c), provider: "Google Drive", email: result.email, folder: result.folderName, recoveryKey: result.fingerprint }, ip);
      return result;
    },

    "POST /cloud/drive/pending/:id/cancel"({ params }) {
      pendingDrives.delete(String(params.id));
      return { ok: true };
    },

    async "POST /cloud/:id/key"({ params, body, admin, ip }) {
      const c = copyOr404(params.id);
      if (c.kind !== "s3") throw new ApiError(400, "Only a bucket has an access key.");
      const old = copies.raw(c.id).settings;
      const settings = cloudSettings({ ...old, keyId: body.keyId, secret: body.secret });
      await cloudTest(settings);
      copies.replaceS3Key(c.id, settings.keyId, settings.secret);
      store.audit(admin.username, "cloud.key-replaced", { for: where(c), keyId: settings.keyId }, ip);
      return copies.get(c.id);
    },

    "POST /cloud/:id/pause"({ params, body, admin, ip }) {
      const c = copyOr404(params.id);
      copies.setPaused(c.id, !!body.paused);
      store.audit(admin.username, body.paused ? "cloud.paused" : "cloud.resumed", { for: where(c) }, ip);
      return copies.get(c.id);
    },

    // "Check now"; on the failsafe it's "Back up everything now"
    "POST /cloud/:id/sync"({ params, admin, ip }) {
      const c = copyOr404(params.id);
      if (c.paused) throw new ApiError(409, "This copy is paused. Resume it first.");
      copies.syncNow(c.id);
      if (c.failsafe) store.audit(admin.username, "cloud.failsafe-now", {}, ip);
      return { ok: true };
    },

    // Confirm with the bucket name or the Google account's email
    "POST /cloud/:id/disconnect"({ params, body, admin, ip }) {
      const c = copyOr404(params.id);
      const name = c.kind === "s3" ? c.bucket : c.email;
      if (String(body.confirm ?? "").trim().toLowerCase() !== String(name ?? "").toLowerCase()) {
        throw new ApiError(400, `Type ${c.kind === "s3" ? "the bucket name" : "the Google account's email"} exactly to confirm.`);
      }
      copies.disconnect(c.id);
      store.audit(admin.username, "cloud.disconnected", { for: where(c), target: name }, ip);
      log.warn(`Admin "${admin.username}" disconnected the off-site copy ${where(c)} (${name})`);
      return { ok: true };
    },
  });

  // Google sends the browser here after the person allowed (or refused) access. There's no
  // session cookie on this request (it comes from google.com, and the cookie is SameSite=Strict);
  // the one-time state proves it's a sign-in an admin started here in the last 10 minutes.
  // Returns where to send the browser next.
  async function oauthCallback(query, ip) {
    const pending = signIns.get(String(query.state ?? ""));
    if (!pending || pending.expires < Date.now()) return "/offsite?drive_error=" + encodeURIComponent("That sign-in expired or was already used. Start again.");
    signIns.delete(String(query.state));
    const back = (extra) => `${pending.back}?${extra}`;
    if (query.error) {
      return back("drive_error=" + encodeURIComponent(query.error === "access_denied" ? "Access to Google Drive wasn't allowed." : `Google said: ${query.error}`));
    }
    try {
      const refreshToken = await finishSignIn({ ...pending, code: String(query.code ?? "") });
      const sign = { clientId: pending.clientId, clientSecret: pending.clientSecret, refreshToken };
      if (pending.resign) {
        await copies.resignDrive(pending.resign, sign);
        store.audit(pending.admin, "cloud.drive-signed-in-again", { copy: pending.resign }, ip);
        return back("drive=signed-in");
      }
      // Next the person chooses the folder (see /cloud/drive/pending)
      const { email } = await createDrive(sign).about();
      const id = crypto.randomBytes(12).toString("base64url");
      pendingDrives.set(id, { sign, deviceId: pending.deviceId, admin: pending.admin, email, expires: Date.now() + 30 * 60_000 });
      return back(`drive_choose=${id}`);
    } catch (err) {
      log.warn(`Google Drive sign-in failed: ${err.message}`);
      return back("drive_error=" + encodeURIComponent(err instanceof CopyError ? err.message : explainDrive(err)));
    }
  }

  routes["GET /quarantine/:id/inspect"] = ({ params, admin, ip }) => {
    const v = db.getVersion(Number(params.id));
    if (!v || v.status !== "quarantined") throw new ApiError(404, "This file is no longer in quarantine.");
    const device = getDeviceOr404(v.device_id);
    const held = summary(device, v);
    const lastGood = summary(device, db.lastOkVersion(device.id, v.rel_path));
    store.audit(admin.username, "quarantine.inspected", { device: device.device_name, path: v.rel_path, version: v.version_no }, ip);
    const strip = (s) => s && (({ sample, ...rest }) => rest)(s);
    return {
      id: v.id,
      path: v.rel_path,
      device: device.device_name,
      client: device.client_name,
      held: strip(held),
      lastGood: strip(lastGood),
      preview: previewOf(held.sample, v.size),
      lastGoodPreview: lastGood ? previewOf(lastGood.sample.subarray(0, 4096), lastGood.size) : null,
    };
  };

  // Release (status "ok") or reject quarantined versions
  function review(body, status, admin, ip) {
    const ids = Array.isArray(body.ids) ? body.ids.filter(Number.isInteger).slice(0, 1000) : [];
    if (!ids.length) throw new ApiError(400, "No items selected.");
    let changed = 0;
    for (const id of ids) {
      const v = db.getVersion(id);
      if (!db.reviewVersion(id, status, admin.username)) continue;
      changed++;
      const device = db.getDevice(v.device_id);
      const infected = v.scan_status === "infected";
      security?.event(
        status === "ok" ? (infected ? "critical" : "medium") : "low",
        status === "ok" ? "quarantine.released" : "quarantine.rejected",
        `${admin.username} ${status === "ok" ? "released" : "rejected"} ${v.rel_path} from ${device?.device_name ?? v.device_id}${infected && status === "ok" ? ` despite ${v.scan_signature}` : ""}`,
        { deviceId: v.device_id, versionId: v.id, detail: { by: admin.username, path: v.rel_path, signature: infected ? v.scan_signature : null } },
      );
    }
    if (status === "ok" && changed) copies.syncNow(); // released files go off-site now
    const action = status === "ok" ? "quarantine.released" : "quarantine.rejected";
    store.audit(admin.username, action, { count: changed }, ip);
    log.info(`Admin "${admin.username}" ${status === "ok" ? "released" : "rejected"} ${changed} quarantined version(s)`);
    return { changed };
  }

  if (security) Object.assign(routes, securityRoutes({ db, security, scanner, broker, ApiError }));
  if (updates) Object.assign(routes, updatesRoutes({ db, store, updates, installs, broker, ApiError, getDeviceOr404, log }));
  if (notify) Object.assign(routes, notifyRoutes({ notify, health, store, ApiError }));
  if (address) Object.assign(routes, addressRoutes({ address, store, ApiError }));
  if (removals) Object.assign(routes, serviceRoutes({ db, store, removals, health, broker, copies, dataDir: config.dataDir, ApiError, getDeviceOr404, requireMultiFolder, agentStatusOf, log }));

  // Turn "GET /devices/:id/files" patterns into matchers
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ");
    const names = [];
    const re = new RegExp(
      "^" + pattern.replace(/:[a-zA-Z]+/g, (m) => (names.push(m.slice(1)), "([A-Za-z0-9_-]+)")) + "$"
    );
    return { method, re, names, handler, isLogin: pattern === "/login", key };
  });

  // In lockdown, only what's in ALLOWED_IN_LOCKDOWN changes anything (lockdown.js)
  const lockedHandler = () => {
    throw new ApiError(423, "Lockdown is on: nothing can be changed or deleted until it's lifted with the recovery key (Security page).");
  };

  function match(method, pathname) {
    for (const r of compiled) {
      if (r.method !== method) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const locked = method !== "GET" && lockdown?.isOn() && !ALLOWED_IN_LOCKDOWN.has(r.key);
      return { handler: locked ? lockedHandler : r.handler, isLogin: r.isLogin, params: Object.fromEntries(r.names.map((n, i) => [n, m[i + 1]])) };
    }
    return null;
  }
  match.oauthCallback = oauthCallback;
  return match;
}