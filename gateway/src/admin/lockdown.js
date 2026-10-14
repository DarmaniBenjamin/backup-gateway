// Lockdown: during an attack, nothing on the gateway can be changed or deleted from the web UI.
// Backups keep running, and restores and integrity checks still work. It turns on by itself when
// the login is attacked (login-guard.js), or with the button on the Security page.
//
// Lifting it needs the recovery key (BGRK-…, made with the first off-site copy), which an attacker
// with a stolen password doesn't have. Without a recovery key, or if it's lost, lift it on the
// server itself:  cd gateway && npm run lockdown -- off

import { parseRecoveryKey } from "../cloud/recovery.js";

// What still works in lockdown: signing in and out, getting files back, checking, two-factor setup
export const ALLOWED_IN_LOCKDOWN = new Set([
  "POST /login",
  "POST /logout",
  "POST /lockdown",
  "POST /lockdown/lift",
  "POST /restore/preview",
  "POST /restore",
  "POST /devices/:id/browse", // looking at a device's folders changes nothing
  "POST /verify",
  "POST /alerts/:id/ack",
  "POST /me/2fa/start",
  "POST /me/2fa/confirm",
  "POST /me/2fa/recovery-codes",
]);

export function createLockdown({ store, security = null, copies = null }) {
  const get = () => store.getSetting("lockdown") ?? { on: false };

  return {
    get,
    isOn: () => !!get().on,
    view() {
      const s = get();
      return { on: !!s.on, since: s.since ?? null, reason: s.reason ?? null, by: s.by ?? null, liftWithKey: !!copies?.recovery?.() };
    },
    turnOn(reason, by, ip = null) {
      if (get().on) return get();
      const s = { on: true, since: new Date().toISOString(), reason, by };
      store.setSetting("lockdown", s);
      store.audit(by, "lockdown.on", { reason }, ip);
      security?.event("critical", "admin.lockdown", `Lockdown is on: ${reason}. Nothing can be changed or deleted until it's lifted with the recovery key.`, { detail: { by, reason } });
      return s;
    },
    // From the web UI: only with the recovery key
    lift(recoveryKey, by, ip) {
      const r = copies?.recovery?.();
      if (!r) throw new Error("This gateway has no recovery key yet. Lift lockdown on the server: cd gateway && npm run lockdown -- off");
      let fingerprint;
      try {
        ({ fingerprint } = parseRecoveryKey(recoveryKey));
      } catch (err) {
        throw new Error(err.message);
      }
      if (fingerprint !== r.fingerprint) {
        store.audit(by, "lockdown.lift-refused", null, ip);
        security?.event("high", "admin.lockdown", `Someone signed in as "${by}" tried to lift lockdown with the wrong recovery key`, { detail: { by, ip } });
        throw new Error("That isn't this gateway's recovery key.");
      }
      store.setSetting("lockdown", { on: false });
      store.audit(by, "lockdown.off", null, ip);
      security?.event("info", "admin.lockdown", `Lockdown lifted by ${by} with the recovery key`, { detail: { by } });
      return { on: false };
    },
  };
}
