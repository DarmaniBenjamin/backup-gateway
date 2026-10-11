// Admin API for agent updates (see updates.js):
//   GET  /updates                        this gateway's agent version, the setting, every device
//   POST /updates/policy   { auto }      automatic updates on or off
//   POST /devices/:id/update { action }  "now" (update as soon as possible), "hold" or "resume"
//   POST /devices/:id/updater-link       a one-time command that adds the updater to an agent
//                                        installed before 0.15 (keeps its identity and settings)

import { PLATFORMS } from "../installs.js";

export function updatesRoutes({ db, store, updates, installs, broker, ApiError, getDeviceOr404, log }) {
  function platformOf(device) {
    if (device.platform === "win32") return "windows";
    let status = null;
    try {
      status = device.agent_status ? JSON.parse(device.agent_status) : null;
    } catch {
      status = null;
    }
    if (status?.dsmExport) return "synology";
    return device.platform === "linux" ? "linux" : null;
  }

  return {
    "GET /updates"() {
      return {
        version: updates.version,
        auto: updates.auto(),
        devices: updates.list(db.listDevices(), broker).map((d) => ({ ...d, installPlatform: platformOf(db.getDevice(d.id)) })),
      };
    },

    "POST /updates/policy"({ body, admin, ip }) {
      updates.setAuto(!!body.auto);
      store.audit(admin.username, body.auto ? "updates.auto-on" : "updates.auto-off", null, ip);
      log.info(`Admin "${admin.username}" turned automatic agent updates ${body.auto ? "on" : "off"}`);
      return { auto: updates.auto() };
    },

    "POST /devices/:id/update"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      const action = String(body.action ?? "");
      if (action === "now") updates.requestNow(d.id);
      else if (action === "hold" || action === "resume") updates.setHold(d.id, action === "hold");
      else throw new ApiError(400, "Unknown action.");
      store.audit(admin.username, `updates.${action}`, { device: d.device_name }, ip);
      if (action === "now") broker.wake(d.id); // it picks the offer up on its next heartbeat, right away
      return { ok: true };
    },

    "POST /devices/:id/updater-link"({ params, body, admin, ip }) {
      const d = getDeviceOr404(params.id);
      const platform = PLATFORMS.includes(body.platform) ? body.platform : platformOf(d);
      if (!platform) throw new ApiError(400, "Pick what kind of device this is.");
      const expiresAt = new Date(Date.now() + 60 * 60_000);
      const install = installs.create({ code: null, clientName: d.client_name, expiresAt, options: { platform, upgrade: true } });
      store.audit(admin.username, "updates.updater-link", { device: d.device_name, platform }, ip);
      return { ...install, expiresAt: expiresAt.toISOString() };
    },
  };
}
