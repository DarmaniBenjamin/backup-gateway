// Two-factor login and lockdown through the real admin API (src/admin/api.js) and database
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { openAdminStore } from "../src/admin/admin-store.js";
import { createAdminApi } from "../src/admin/api.js";
import { createLockdown } from "../src/admin/lockdown.js";
import { hashPassword } from "../src/admin/passwords.js";
import { codeAt, counterNow } from "../src/admin/totp.js";
import { createRecoveryKey } from "../src/cloud/recovery.js";
import { createSecurity } from "../src/security.js";

const PASSWORD = "Correct-Horse-Battery-9";

async function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-test-"));
  const db = openDatabase(dataDir);
  const store = openAdminStore(dataDir);
  store.addAdmin("dana", await hashPassword(PASSWORD));
  const recovery = createRecoveryKey();
  const copies = { googleClient: () => null, recovery: () => ({ publicKey: recovery.publicKey, fingerprint: recovery.fingerprint }) };
  // The real security module (its database tables), with its events recorded for the checks
  const events = [];
  const security = createSecurity({ db, dataDir, keys: {}, storage: {}, scanner: { onUnavailable() {}, onAvailable() {}, status: () => ({}) } });
  const realEvent = security.event;
  security.event = (...a) => (events.push(a), realEvent(...a));
  const lockdown = createLockdown({ store, security, copies });
  const match = createAdminApi({ db, store, keys: {}, storage: {}, config: { dataDir, adminPort: 8090 }, broker: {}, installs: {}, copies, security, lockdown });
  const admin = { id: store.adminByName("dana").id, username: "dana" };
  // Calls a route the way admin-server.js does (after its session check)
  const call = async (method, p, body = {}, who = admin, ip = "10.0.0.5") => {
    const route = match(method, p);
    if (!route) throw new Error(`no route ${method} ${p}`);
    let session = null;
    return { result: await route.handler({ admin: who, params: route.params, query: {}, host: "127.0.0.1:8090", body, ip, setSession: (id) => (session = id), clearSession() {} }), session: () => session };
  };
  return { store, call, recovery, events, lockdown, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

const status = async (p) => {
  try {
    await p;
  } catch (err) {
    return err.status;
  }
  return 200;
};

test("two-factor: turn on, then signing in needs the code; codes work once", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  assert.equal(await status(s.call("POST", "/me/2fa/start", { password: "wrong" })), 403);
  const { result: start } = await s.call("POST", "/me/2fa/start", { password: PASSWORD });
  const step = counterNow();
  const { result: done } = await s.call("POST", "/me/2fa/confirm", { code: codeAt(start.secret, step) });
  assert.equal(done.recoveryCodes.length, 10);

  // Password alone: no session, asked for the code
  const pw = await s.call("POST", "/login", { username: "dana", password: PASSWORD }, null);
  assert.deepEqual(pw.result, { needsCode: true });
  assert.equal(pw.session(), null);

  // The code already used to turn it on doesn't work again
  assert.equal(await status(s.call("POST", "/login", { username: "dana", password: PASSWORD, code: codeAt(start.secret, step) }, null)), 401);

  // The next code works, once
  const next = codeAt(start.secret, step + 1);
  const ok = await s.call("POST", "/login", { username: "dana", password: PASSWORD, code: next }, null);
  assert.ok(ok.session());
  assert.equal(await status(s.call("POST", "/login", { username: "dana", password: PASSWORD, code: next }, null)), 401);

  // A recovery code works once
  const rc = done.recoveryCodes[0];
  assert.ok((await s.call("POST", "/login", { username: "dana", password: PASSWORD, code: rc }, null)).session());
  assert.equal(await status(s.call("POST", "/login", { username: "dana", password: PASSWORD, code: rc }, null)), 401);
  assert.equal((await s.call("GET", "/me")).result.recoveryCodesLeft, 9);
});

test("lockdown: changes refused, restores allowed, lifted only with the recovery key", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  await s.call("POST", "/lockdown", { reason: "test" });
  assert.equal((await s.call("GET", "/lockdown")).result.on, true);
  assert.equal(await status(s.call("POST", "/devices/dev_x/folders/f1/remove")), 423);
  assert.equal(await status(s.call("POST", "/cloud/c1/disconnect")), 423);
  assert.equal(await status(s.call("POST", "/enrollment-codes", {})), 423, "no new devices either");
  assert.equal(await status(s.call("POST", "/devices/dev_x/lock", { unlock: true })), 423, "folders cannot be unlocked");
  assert.notEqual(await status(s.call("POST", "/restore", {})), 423, "restores still go through");

  assert.equal(await status(s.call("POST", "/lockdown/lift", { recoveryKey: "BGRK-AAAA" })), 400);
  const other = createRecoveryKey().recoveryKey;
  assert.equal(await status(s.call("POST", "/lockdown/lift", { recoveryKey: other })), 400);
  await s.call("POST", "/lockdown/lift", { recoveryKey: s.recovery.recoveryKey });
  assert.equal(s.lockdown.isOn(), false);
  assert.ok(s.events.some((e) => e[0] === "critical" && e[1] === "admin.lockdown"));
});

test("a login attack from many addresses turns on lockdown", async (t) => {
  const s = await setup();
  t.after(s.cleanup);
  for (let i = 0; i < 20; i++) await status(s.call("POST", "/login", { username: "dana", password: "nope" }, null, `198.51.100.${i % 4}`));
  assert.equal(s.lockdown.isOn(), true);
  assert.ok(s.events.some((e) => e[1] === "admin.login-attack"));
  // ...and the real admin, from elsewhere, still signs in
  assert.ok((await s.call("POST", "/login", { username: "dana", password: PASSWORD }, null, "10.0.0.5")).session());
});
