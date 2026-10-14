// Wrong-password protection (src/admin/login-guard.js)
import test from "node:test";
import assert from "node:assert/strict";
import { createLoginGuard } from "../src/admin/login-guard.js";

test("guessing from one address can't lock the real admin out", () => {
  const g = createLoginGuard();
  for (let i = 0; i < 5; i++) g.failed("6.6.6.6", "admin");
  assert.ok(g.blocked("6.6.6.6", "admin"), "the guessing address is blocked for that account");
  assert.equal(g.blocked("10.0.0.5", "admin"), null, "the admin from elsewhere still gets in");
});

test("an address is blocked after 10 wrong tries, whatever the username", () => {
  const g = createLoginGuard();
  for (let i = 0; i < 10; i++) g.failed("6.6.6.6", `user${i}`);
  assert.ok(g.blocked("6.6.6.6", "someone-else"));
});

test("each wrong try waits longer, up to 8 seconds", () => {
  const g = createLoginGuard();
  assert.equal(g.delayMs("1.1.1.1"), 0);
  g.failed("1.1.1.1", "a");
  const first = g.delayMs("1.1.1.1");
  g.failed("1.1.1.1", "a");
  assert.ok(g.delayMs("1.1.1.1") > first);
  for (let i = 0; i < 20; i++) g.failed("1.1.1.1", "a");
  assert.equal(g.delayMs("1.1.1.1"), 8000);
});

test("blocks end after 15 minutes", () => {
  let t = 0;
  const g = createLoginGuard({ now: () => t });
  for (let i = 0; i < 10; i++) g.failed("6.6.6.6", "admin");
  assert.ok(g.blocked("6.6.6.6", "admin"));
  t += 15 * 60_000 + 1;
  assert.equal(g.blocked("6.6.6.6", "admin"), null);
});

test("many addresses guessing one username is an attack, reported once", () => {
  const attacks = [];
  const g = createLoginGuard({ onAttack: (r) => attacks.push(r) });
  for (let i = 0; i < 25; i++) g.failed(`6.6.6.${i % 5}`, "admin");
  assert.equal(attacks.length, 1);
  assert.match(attacks[0], /"admin" from 5 addresses/);
});

test("a correct login clears that address's tries for the account", () => {
  const g = createLoginGuard();
  for (let i = 0; i < 4; i++) g.failed("10.0.0.5", "admin");
  g.succeeded("10.0.0.5", "admin");
  g.failed("10.0.0.5", "admin");
  assert.equal(g.blocked("10.0.0.5", "admin"), null);
});
