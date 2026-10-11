// Admin API for the Alerts page (see notify/notify.js and health.js):
//   GET  /notify                       channels, settings, recent sends, what can be picked
//   POST /notify/channels              { kind, name, settings, minSeverity, categories }   add one
//   POST /notify/channels/:id          the same, to change one (empty secret fields keep the saved ones)
//   POST /notify/channels/:id/enabled  { enabled }
//   POST /notify/channels/:id/remove
//   POST /notify/channels/:id/test     send a test alert now
//   POST /notify/test                  { channel } test settings before saving them
//   POST /notify/settings              { gatewayName, offlineHours, diskPercent }
// Passwords, tokens, secrets and webhook addresses never come back, and aren't in the audit log.

import { CATEGORIES, EMAIL_SECURITY, KINDS, NotifyError, WEBHOOK_FORMATS, newTopic } from "../notify/notify.js";
import { SEVERITIES } from "../security.js";

export function notifyRoutes({ notify, health, store, ApiError }) {
  const guard = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof NotifyError) throw new ApiError(400, err.message);
      throw err;
    }
  };
  const idOf = (params) => {
    const id = Number(params.id);
    if (!notify.get(id)) throw new ApiError(404, "That channel doesn't exist any more.");
    return id;
  };

  return {
    "GET /notify"() {
      return {
        channels: notify.list(),
        settings: notify.settings(),
        log: notify.log(40),
        disk: health.disk(),
        offlineDevices: health.offline().length,
        choices: { kinds: KINDS, severities: SEVERITIES, categories: CATEGORIES.map(({ id, label }) => ({ id, label })), emailSecurity: EMAIL_SECURITY, webhookFormats: WEBHOOK_FORMATS },
        suggestedTopic: newTopic(),
      };
    },

    "POST /notify/channels"({ body, admin, ip }) {
      return guard(() => {
        const c = notify.add(body);
        store.audit(admin.username, "notify.channel-added", { name: c.name, kind: c.kind }, ip);
        return c;
      });
    },
    "POST /notify/channels/:id"({ params, body, admin, ip }) {
      const id = idOf(params);
      return guard(() => {
        const c = notify.update(id, body);
        store.audit(admin.username, "notify.channel-changed", { name: c.name, kind: c.kind }, ip);
        return c;
      });
    },
    "POST /notify/channels/:id/enabled"({ params, body, admin, ip }) {
      const id = idOf(params);
      notify.setEnabled(id, !!body.enabled);
      store.audit(admin.username, body.enabled ? "notify.channel-on" : "notify.channel-off", { name: notify.get(id).name }, ip);
      return { ok: true };
    },
    "POST /notify/channels/:id/remove"({ params, admin, ip }) {
      const id = idOf(params);
      const name = notify.get(id).name;
      notify.remove(id);
      store.audit(admin.username, "notify.channel-removed", { name }, ip);
      return { ok: true };
    },
    "POST /notify/channels/:id/test"({ params }) {
      const id = idOf(params);
      return guard(async () => {
        await notify.test({ id });
        return { ok: true };
      });
    },
    "POST /notify/test"({ body }) {
      const id = body.id ? idOf({ id: body.id }) : null;
      return guard(async () => {
        await notify.test({ id, input: body.channel });
        return { ok: true };
      });
    },
    "POST /notify/settings"({ body, admin, ip }) {
      return guard(() => {
        const s = notify.setSettings(body);
        store.audit(admin.username, "notify.settings-changed", s, ip);
        health.checkDisk();
        return s;
      });
    },
  };
}
