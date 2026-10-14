// The agent port's front door (src/server.js): the web UI by IP only with the setup link before the
// domain works, then only at https://<domain>; agent paths always work.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer } from "../src/server.js";
import { setupCookieValue } from "../src/setup-key.js";

const KEY = "k".repeat(32);

async function start(live) {
  const server = createServer({
    db: {}, keys: {}, storage: {}, guard: {}, broker: {}, installs: null,
    address: { liveDomain: () => live },
    webUi: (req, res) => res.end("WEB UI"),
    setupKey: KEY,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}

// A request to the server, as if from `from` (127.0.0.1 = Caddy or the tunnel on this computer)
function get(server, path, headers = {}, fakeRemote = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (fakeRemote) req.on("socket", (s) => Object.defineProperty(s, "remoteAddress", { value: fakeRemote }));
    req.end();
  });
}

// Requests from another computer: the server sees a non-loopback address
function asRemote(server) {
  const orig = server.listeners("request")[0];
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    Object.defineProperty(req.socket, "remoteAddress", { value: "203.0.113.7", configurable: true });
    orig(req, res);
  });
}

const viaCaddy = { Host: "backup.acme.io", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9" };

test("before a domain: by IP only with the setup link", async (t) => {
  const s = await start(null);
  t.after(() => s.close());
  asRemote(s);
  const blocked = await get(s, "/");
  assert.equal(blocked.status, 403);
  assert.match(blocked.body, /setup link/);

  const wrong = await get(s, "/?setup=nope");
  assert.equal(wrong.status, 403);

  const opened = await get(s, `/devices?setup=${KEY}`);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.location, "/devices");
  assert.match(opened.headers["set-cookie"][0], /^bg_setup=.+HttpOnly/);

  const withCookie = await get(s, "/", { Cookie: `bg_setup=${setupCookieValue(KEY)}` });
  assert.equal(withCookie.body, "WEB UI");
});

test("before a domain: on the gateway computer itself, no link needed", async (t) => {
  const s = await start(null);
  t.after(() => s.close());
  assert.equal((await get(s, "/")).body, "WEB UI");
});

test("with a domain: the web UI only through it, over https, with HSTS", async (t) => {
  const s = await start("backup.acme.io");
  t.after(() => s.close());
  const ok = await get(s, "/", viaCaddy);
  assert.equal(ok.body, "WEB UI");
  assert.match(ok.headers["strict-transport-security"], /max-age=31536000/);

  const noProxy = await get(s, "/", { Host: "backup.acme.io" });
  assert.equal(noProxy.status, 403);
  assert.match(noProxy.body, /Access by IP address is turned off/);
});

test("with a domain: spoofed proxy headers from another computer are blocked", async (t) => {
  const s = await start("backup.acme.io");
  t.after(() => s.close());
  asRemote(s);
  const r = await get(s, "/", viaCaddy);
  assert.equal(r.status, 403);
  const setup = await get(s, `/?setup=${KEY}`);
  assert.equal(setup.status, 403, "the setup link doesn't open it by IP once there's a domain");
});

test("with a domain: an install link opened by IP goes to the domain", async (t) => {
  const s = await start("backup.acme.io");
  t.after(() => s.close());
  asRemote(s);
  const r = await get(s, "/i/ABC234");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "https://backup.acme.io/i/ABC234");
});

test("agent paths never go to the web UI", async (t) => {
  const s = await start("backup.acme.io");
  t.after(() => s.close());
  asRemote(s);
  const r = await get(s, "/api/hello");
  assert.equal(r.status, 200);
  assert.match(r.body, /backup-gateway/);
});
