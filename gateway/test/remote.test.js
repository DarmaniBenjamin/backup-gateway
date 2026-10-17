// Remote access (src/remote.js, src/server.js): MeshCentral's settings, and the gateway's front door
// for /remote/: only through the domain over https, people only after the gateway's sign-in (so its
// two-factor), the devices' own connections always, and lockdown stopping sessions.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";

process.env.GATEWAY_REMOTE_PORT = "4499"; // a stand-in for MeshCentral, below
const { createServer } = await import("../src/server.js");
const { meshConfig, idToHex } = await import("../src/remote.js");

test("MeshCentral listens on this computer only, behind https, no extra port, no sign-ups", () => {
  const c = meshConfig("backup.acme.io");
  assert.equal(c.settings.portBind, "127.0.0.1");
  assert.equal(c.settings.mpsPort, 0, "its Intel AMT port is off");
  assert.equal(c.settings.tlsOffload, "127.0.0.1");
  assert.equal(c.settings.redirPort, 0);
  assert.equal(c.domains.remote.newAccounts, false);
  assert.equal(c.domains.remote.certUrl, "https://backup.acme.io:443/");
  // Everything it writes stays in the gateway's data folder (its program folder is read-only)
  const h = meshConfig("backup.acme.io", "/srv/gateway-data/remote");
  assert.equal(h.settings.filesPath, "/srv/gateway-data/remote/files");
  assert.equal(h.settings.autoBackup.backupPath, "/srv/gateway-data/meshcentral-backups");
});

test("MeshCentral ids become the hex its links and installers take", () => {
  assert.equal(idToHex("mesh/remote/AAEC"), "000102");
  assert.equal(idToHex("node/remote/@$8="), "FBFF");
});

// The stand-in MeshCentral: answers pages, and accepts WebSockets
const fake = http.createServer((req, res) => res.end(`MESH ${req.url}`));
fake.on("upgrade", (req, sock) => sock.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
await new Promise((r) => fake.listen(4499, "127.0.0.1", r));
test.after(() => fake.close());

const SESSION = "good-session";
async function gateway({ live = "backup.acme.io", locked = false } = {}) {
  const server = createServer({
    db: {}, keys: {}, storage: {}, guard: {}, broker: {}, installs: null,
    address: { liveDomain: () => live },
    webUi: (req, res) => res.end("WEB UI"),
    remote: { isRunning: () => true },
    isLockedDown: () => locked,
    isSignedIn: (token) => token === SESSION,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return server;
}
const viaCaddy = { Host: "backup.acme.io", "X-Forwarded-Proto": "https", "X-Forwarded-For": "203.0.113.9" };
function get(server, path, headers = viaCaddy) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: server.address().port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on("error", reject);
  });
}
// A WebSocket handshake: "upgraded" or "refused"
function upgrade(server, path, headers = viaCaddy) {
  return new Promise((resolve) => {
    const s = net.connect(server.address().port, "127.0.0.1", () => {
      const h = { ...headers, Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==" };
      s.write([`GET ${path} HTTP/1.1`, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n"));
    });
    let got = "";
    s.on("data", (d) => (got += d));
    s.on("close", () => resolve(/^HTTP\/1.1 101/.test(got) ? "upgraded" : "refused"));
    s.on("error", () => resolve("refused"));
    setTimeout(() => s.destroy(), 1500);
  });
}
const withSession = { ...viaCaddy, Cookie: `bg_session=${SESSION}` };

test("a person not signed in to the gateway is sent to its sign-in first, then back", async (t) => {
  const g = await gateway();
  t.after(() => g.close());
  const r = await get(g, "/remote/?gotonode=AB&viewmode=11");
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, "/login?next=%2Fremote%2F%3Fgotonode%3DAB%26viewmode%3D11");
  assert.equal(await upgrade(g, "/remote/control.ashx"), "refused", "nor MeshCentral's control channel");
});

test("signed in to the gateway: through to MeshCentral, pages and live connections", async (t) => {
  const g = await gateway();
  t.after(() => g.close());
  assert.equal((await get(g, "/remote/", withSession)).body, "MESH /remote/");
  assert.equal(await upgrade(g, "/remote/control.ashx", withSession), "upgraded");
});

test("the devices' own connections need no sign-in", async (t) => {
  const g = await gateway();
  t.after(() => g.close());
  assert.equal(await upgrade(g, "/remote/agent.ashx"), "upgraded");
  assert.equal(await upgrade(g, "/remote/meshrelay.ashx?id=x"), "upgraded");
  assert.equal((await get(g, "/remote/meshagents?id=6")).body, "MESH /remote/meshagents?id=6");
});

test("only through the domain over https: not by IP, not without the proxy, not before there's a domain", async (t) => {
  const g = await gateway();
  t.after(() => g.close());
  assert.equal((await get(g, "/remote/", { Host: "backup.acme.io", Cookie: `bg_session=${SESSION}` })).status, 404, "not through the https proxy: not available");
  assert.equal(await upgrade(g, "/remote/agent.ashx", { Host: "203.0.113.5:8080" }), "refused");
  const none = await gateway({ live: null });
  t.after(() => none.close());
  assert.equal((await get(none, "/remote/", withSession)).status, 404);
  assert.equal(await upgrade(none, "/remote/agent.ashx"), "refused");
});

test("lockdown: no remote sessions, but devices stay connected", async (t) => {
  const g = await gateway({ locked: true });
  t.after(() => g.close());
  assert.equal((await get(g, "/remote/", withSession)).status, 423);
  assert.equal(await upgrade(g, "/remote/control.ashx", withSession), "refused");
  assert.equal(await upgrade(g, "/remote/meshrelay.ashx?id=x", withSession), "refused", "no desktop sessions");
  assert.equal(await upgrade(g, "/remote/agent.ashx"), "upgraded");
});

test("adding remote access to an existing device: one line, https only, the right client's group", async () => {
  const { addRemoteCommand } = await import("../src/installs.js");
  const { execFileSync } = await import("node:child_process");
  const r = { url: "https://backup.acme.io/remote", meshId: "ab$c@d" };
  const linux = addRemoteCommand("linux", r);
  assert.match(linux, /--proto =https/);
  assert.match(linux, /meshsettings\?id=ab%24c%40d/, "the group's id, escaped for the address");
  assert.match(linux, /cd "\$d" && /, "runs from the folder with its settings");
  assert.match(linux, /sudo \.\/meshagent -fullinstall --copy-msh=1/, "and keeps them: without, it never connects");
  assert.match(linux, /sudo cp meshagent\.msh \/usr\/local\/mesh_services\/meshagent\/meshagent\.msh && sudo systemctl restart meshagent/, "then puts them where the installed agent reads them");
  execFileSync("bash", ["-n", "-c", linux]); // throws if it isn't valid bash
  const win = addRemoteCommand("win32", r);
  assert.match(win, /meshagents\?id=4&meshid=ab%24c%40d&installflags=0/);
  assert.match(win, /-fullinstall/);
  assert.match(win, /Tls12/, "TLS 1.2 on, for Windows PowerShell 5.1 on older Windows");
  assert.match(win, /\$ErrorActionPreference = 'Stop'/, "a failed download stops it, nothing half-done is run");
  assert.equal(addRemoteCommand("linux", null), null, "nothing when remote access isn't on");
});
