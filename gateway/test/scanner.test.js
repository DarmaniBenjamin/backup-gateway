// Finding ClamAV (src/scanner.js), with fake clamd sockets
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createScanner } from "../src/scanner.js";

// A fake clamd that answers each command with replies[command]
async function fakeClamd(t, replies) {
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clamd-")), "clamd.ctl");
  const server = net.createServer((c) => c.on("data", (d) => c.end(`${replies[String(d).replace(/^z|\0$/g, "")] ?? "UNKNOWN COMMAND"}\0`)));
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  return sock;
}

test("a normal ClamAV: found, with its version", async (t) => {
  const sock = await fakeClamd(t, { VERSION: "ClamAV 1.4.3/27800/Wed Oct 14 09:30:00 2026", PING: "PONG" });
  const s = await createScanner(sock).check();
  assert.equal(s.available, true);
  assert.equal(s.engine, "1.4.3");
  assert.equal(s.signatures, 27800);
  assert.equal(s.versionHidden, false);
});

test("VERSION turned off in clamd.conf (EnableVersionCommand no): still found, through PING", async (t) => {
  const sock = await fakeClamd(t, { VERSION: "COMMAND UNAVAILABLE", PING: "PONG" });
  const s = await createScanner(sock).check();
  assert.equal(s.available, true);
  assert.equal(s.versionHidden, true);
  assert.equal(s.signatures, null);
  assert.equal(s.error, null);
});

test("something that isn't ClamAV: not used, and says why", async (t) => {
  const sock = await fakeClamd(t, { VERSION: "hello", PING: "nope" });
  const s = await createScanner(sock).check();
  assert.equal(s.available, false);
  assert.match(s.error, /unexpected reply: hello/);
});
