// Admin API for a device's service: pause it, uninstall its agent from here, or remove it.
//   GET  /devices/:id/service                 what's possible, and any uninstall in progress
//   POST /devices/:id/pause     { paused }    stop or restart sending backups (everything is kept)
//   POST /devices/:id/uninstall { confirm }   uninstall the agent (now, or when it next connects)
//   POST /devices/:id/uninstall/cancel        before it has started
//   POST /devices/:id/forget    { confirm }   remove a device that's gone, without uninstalling
//   POST /devices/:id/delete    { confirm }   a removed device: delete it and its backups for good
//   POST /devices/:id/keep      { keep }      a removed device: never delete it automatically (or do again)
//   GET  /removed-devices/auto-delete         { days, choices }: removed devices deleted after N days
//   POST /removed-devices/auto-delete { days } 0 = never
// "confirm" is the device's name, typed in, so it's never done by a slip of the mouse.

import { settingsOf } from "../device-settings.js";
import { UNINSTALL_FROM } from "../removals.js";

export function serviceRoutes({ db, store, removals, health, broker, copies, dataDir, ApiError, getDeviceOr404, requireMultiFolder, agentStatusOf, log }) {
  const confirmed = (d, body) => String(body.confirm ?? "").trim().toLowerCase() === d.device_name.trim().toLowerCase();

  function view(d) {
    const r = removals.get(d.id);
    const status = agentStatusOf(d);
    return {
      status: d.status,
      paused: settingsOf(d).paused,
      canPause: (d.path_layout ?? 1) >= 2,
      locked: !!status?.lock?.locked,
      live: broker.isLive(d.id),
      readiness: removals.readiness(d),
      uninstallFrom: UNINSTALL_FROM,
      storedBytes: db.storageStats().find((x) => x.device_id === d.id)?.stored ?? 0,
      autoDelete: d.status === "active" ? null : removals.autoDeleteOf(d.id),
      removal: r && {
        state: r.state, requestedAt: r.requested_at, requestedBy: r.requested_by, deliveredAt: r.delivered_at,
        confirmedAt: r.confirmed_at, finishedAt: r.finished_at, message: r.message,
      },
    };
  }

  return {
    "GET /devices/:id/service"({ params }) {
      return view(getDeviceOr404(params.id));
    },

    "POST /devices/:id/pause"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (d.status !== "active") throw new ApiError(409, "This device is removed.");
      requireMultiFolder(d);
      const paused = !!body.paused;
      db.setDeviceSettings(d.id, { ...settingsOf(d), paused });
      db.bumpFoldersVersion(d.id);
      broker.wake(d.id);
      store.audit(admin.username, paused ? "device.paused" : "device.resumed", { device: d.device_name }, ip);
      log.info(`Admin "${admin.username}" ${paused ? "paused" : "resumed"} backups on ${d.device_name}`);
      return view(db.getDevice(d.id));
    },

    "POST /devices/:id/uninstall"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (d.status !== "active") throw new ApiError(409, "This device is already removed.");
      if (!confirmed(d, body)) throw new ApiError(400, `Type the device's name (${d.device_name}) to confirm.`);
      const r = removals.request(d, admin.username);
      if (!r.ok) {
        throw new ApiError(409, "This agent was installed before it could uninstall itself. Turn on automatic updates for it first (one command, on its Agent card), or remove it without uninstalling.");
      }
      store.audit(admin.username, "device.uninstall-requested", { device: d.device_name }, ip);
      return view(db.getDevice(d.id));
    },

    "POST /devices/:id/uninstall/cancel"({ params, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (!removals.cancel(d)) throw new ApiError(409, "It can't be cancelled any more: the device has started uninstalling.");
      store.audit(admin.username, "device.uninstall-cancelled", { device: d.device_name }, ip);
      return view(db.getDevice(d.id));
    },

    "POST /devices/:id/forget"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (d.status !== "active") throw new ApiError(409, "This device is already removed.");
      if (!confirmed(d, body)) throw new ApiError(400, `Type the device's name (${d.device_name}) to confirm.`);
      removals.forget(d, admin.username);
      health.checkDevices();
      store.audit(admin.username, "device.removed", { device: d.device_name }, ip);
      return view(db.getDevice(d.id));
    },

    async "POST /devices/:id/delete"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (d.status === "active") throw new ApiError(409, "Uninstall or remove the device first.");
      if (!confirmed(d, body)) throw new ApiError(400, `Type the device's name (${d.device_name}) to confirm.`);
      const stored = db.storageStats().find((x) => x.device_id === d.id);
      await removals.purge(d, { copies, dataDir });
      store.audit(admin.username, "device.deleted", { device: d.device_name, client: d.client_name, storedBytes: stored?.stored ?? 0 }, ip);
      log.info(`Admin "${admin.username}" deleted ${d.device_name} (${d.client_name}) and its backups for good`);
      return { ok: true };
    },

    "POST /devices/:id/keep"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      if (d.status === "active") throw new ApiError(409, "This device isn't removed.");
      const keep = !!body.keep;
      if (!removals.keep(d, keep, admin.username)) throw new ApiError(409, "This device's removal isn't finished yet.");
      store.audit(admin.username, keep ? "device.backups-kept" : "device.backups-unkept", { device: d.device_name }, ip);
      return view(db.getDevice(d.id));
    },

    "GET /removed-devices/auto-delete"() {
      return removals.autoDelete();
    },

    "POST /removed-devices/auto-delete"({ body, admin, ip }) {
      const days = Number(body.days);
      try {
        removals.setAutoDelete(days, admin.username);
      } catch (err) {
        throw new ApiError(400, err.message);
      }
      store.audit(admin.username, "devices.auto-delete", { days }, ip);
      return removals.autoDelete();
    },
  };
}
