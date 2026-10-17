// Remote access: remote desktop, terminal and files for the devices, in the browser. It's MeshCentral
// (gateway/remote, pinned), run by the gateway itself on the same server: no other server or service.
//
//   - It's at https://<domain>/remote/, passed through by the gateway (server.js), and only turns on
//     once the Domain & SSL page has a domain that works: remote control only ever goes over https.
//   - It listens on this computer only (127.0.0.1:4430), with no other port (its Intel AMT port is off).
//   - Each client is a device group. The install command adds MeshCentral's agent to the device, in
//     its client's group (installs.js), and the gateway matches it to the device by name.
//   - People only reach it after the gateway's own sign-in (so its two-factor login, server.js), then
//     sign in with their own remote-access password (set from the Account page). The gateway's own
//     account ("gateway", a random password in the data folder) only manages the groups. Every
//     session is logged by MeshCentral. Lockdown stops new sessions.
//
// The gateway talks to it with MeshCentral's own command-line tool (meshctrl.js).

import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import tls from "node:tls";
import { log } from "./logger.js";

export const REMOTE_PORT = Number(process.env.GATEWAY_REMOTE_PORT) || 4430;
export const REMOTE_PATH = "/remote";
const DOMAIN = "remote"; // MeshCentral's own name for it: everything is under /remote/
const SERVICE_USER = "gateway";
const NODES_MS = 60_000;
const WATCH_MS = 30_000;
const CERT_CHECK_MS = 6 * 60 * 60_000;

// The site's https certificate, as anyone connecting sees it. MeshCentral reads it when it starts
// (certUrl) and checks the agents see the same one, so nobody can sit in between; when Let's Encrypt
// renews it, MeshCentral is restarted to read the new one.
function certFingerprint(domain) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: domain, port: 443, servername: domain, timeout: 15_000 }, () => {
      const fp = s.getPeerCertificate()?.fingerprint256 ?? null;
      s.end();
      resolve(fp);
    });
    s.on("error", () => resolve(null));
    s.on("timeout", () => (s.destroy(), resolve(null)));
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = path.join(here, "..", "remote", "node_modules", "meshcentral");

// MeshCentral ids are base64 with @ and $ for + and /; links and installers take them as hex
export const idToHex = (id) => Buffer.from(String(id).split("/").pop().replace(/@/g, "+").replace(/\$/g, "/"), "base64").toString("hex").toUpperCase();
const sameName = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

// MeshCentral's settings for this gateway. home: its folder in the gateway's data folder. Everything
// it writes goes there: the gateway's service can't write anywhere else (its program folder is
// read-only), so its files and its own backups are kept there too, not next to MeshCentral. (Its
// backups go beside its folder, not in it: MeshCentral won't keep them inside its own data.)
export function meshConfig(domain, home = null) {
  return {
    settings: {
      ...(home ? { filesPath: path.join(home, "files"), autoBackup: { backupPath: path.join(path.dirname(home), "meshcentral-backups"), backupIntervalHours: 24, keepLastDays: 7 } } : {}),
      cert: domain,
      port: REMOTE_PORT,
      portBind: "127.0.0.1",
      aliasPort: 443,
      redirPort: 0,
      mpsPort: 0,
      tlsOffload: "127.0.0.1",
      trustedProxy: "127.0.0.1",
      exactPorts: true,
      selfUpdate: false,
      WANonly: true,
      minify: true,
    },
    domains: {
      "": { title: "Remote access", newAccounts: false },
      [DOMAIN]: {
        title: "Remote access",
        newAccounts: false,
        certUrl: `https://${domain}:443/`,
        // Two-factor is the gateway's: remote access only opens for a gateway account with it on
        // (server.js), so MeshCentral doesn't ask for a second one of its own
        passwordRequirements: { min: 12 },
        // Unattended devices managed by your company: no prompt on the device before a session
        desktopNotify: false,
      },
    },
  };
}

export function createRemote({ dataDir, address, security = null, meshDir = process.env.GATEWAY_REMOTE_DIR || DEFAULT_DIR }) {
  const home = path.join(dataDir, "remote");
  const accountFile = path.join(dataDir, "remote-account.json");
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS remote_groups (
      client_name TEXT PRIMARY KEY COLLATE NOCASE,
      mesh_id     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remote_nodes (
      device_id TEXT PRIMARY KEY,
      node_id   TEXT NOT NULL
    );
  `);
  const q = {
    group: conn.prepare("SELECT mesh_id FROM remote_groups WHERE client_name = ?"),
    groups: conn.prepare("SELECT client_name, mesh_id FROM remote_groups"),
    addGroup: conn.prepare("INSERT OR REPLACE INTO remote_groups (client_name, mesh_id) VALUES (?, ?)"),
    node: conn.prepare("SELECT node_id FROM remote_nodes WHERE device_id = ?"),
    setNode: conn.prepare("INSERT OR REPLACE INTO remote_nodes (device_id, node_id) VALUES (?, ?)"),
  };

  let child = null;
  let runningFor = null; // the domain it was started with
  let ready = false;
  let error = null;
  let stopping = false;
  let restarts = 0;
  let timer = null;
  let nodesAt = 0;
  let certSeen = null; // the certificate MeshCentral started with
  let certCheckedAt = 0;
  let nodes = [];

  const installed = () => fs.existsSync(path.join(meshDir, "meshcentral.js"));
  const node = process.execPath;

  function account() {
    try {
      return JSON.parse(fs.readFileSync(accountFile, "utf8"));
    } catch {
      return null;
    }
  }

  const runMesh = (args, timeout = 120_000) =>
    new Promise((resolve, reject) => {
      execFile(node, [path.join(meshDir, "meshcentral.js"), "--datapath", home, ...args], { timeout, cwd: meshDir }, (err, stdout, stderr) =>
        err ? reject(new Error(`${String(stderr || stdout || err.message).trim().split("\n").pop()}`)) : resolve(String(stdout))
      );
    });

  // A MeshCentral command, as the gateway's own account. JSON out when asked for.
  function meshctrl(args, { json = false, timeout = 60_000 } = {}) {
    const a = account();
    if (!a) return Promise.reject(new Error("Remote access isn't set up yet."));
    const full = [path.join(meshDir, "meshctrl.js"), ...args, "--url", `ws://127.0.0.1:${REMOTE_PORT}${REMOTE_PATH}`, "--loginuser", a.user, "--loginpass", a.password, ...(json ? ["--json"] : [])];
    return new Promise((resolve, reject) => {
      execFile(node, full, { timeout, cwd: meshDir, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        const out = String(stdout ?? "").trim();
        if (err && !out) return reject(new Error(err.message));
        if (!json) return resolve(out);
        try {
          resolve(JSON.parse(out));
        } catch {
          reject(new Error(out.split("\n").pop() || "MeshCentral gave no answer"));
        }
      });
    });
  }

  // First time: MeshCentral's data folder, and the gateway's own account (done while it's stopped)
  async function prepare(domain) {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(meshConfig(domain, home), null, 2), { mode: 0o600 });
    if (!account()) {
      const password = crypto.randomBytes(24).toString("base64url");
      await runMesh(["--createaccount", SERVICE_USER, "--pass", password, "--domain", DOMAIN, "--name", "Backup gateway"]);
      await runMesh(["--adminaccount", SERVICE_USER, "--domain", DOMAIN]);
      fs.writeFileSync(accountFile, JSON.stringify({ user: SERVICE_USER, password }), { mode: 0o600 });
      log.info("Remote access: MeshCentral set up");
    }
  }

  function startChild(domain) {
    ready = false;
    // --debug agent: MeshCentral says what happens to each agent; only those outcomes are logged (below)
    const p = spawn(node, [path.join(meshDir, "meshcentral.js"), "--datapath", home, "--debug", "agent"], { cwd: meshDir, stdio: ["ignore", "pipe", "pipe"] });
    child = p;
    runningFor = domain;
    const onLine = (buf) => {
      for (const line of String(buf).split("\n").map((l) => l.trim()).filter(Boolean)) {
        if (/HTTP server running/i.test(line)) {
          ready = true;
          error = null;
          restarts = 0;
          log.info(`Remote access: running at https://${domain}${REMOTE_PATH}/`);
        } else if (/bad web cert/i.test(line)) {
          // An agent saw a different https certificate from the one MeshCentral read when it started
          // (renewed since, or another one served): read the current one again, and let it in
          log.warn(`Remote access: ${line.slice(0, 300)}`);
          reloadCert();
        } else if (/^AGENT: (New agent at|Verified agent connection)/.test(line)) {
          log.info(`Remote access: ${line.replace(/^AGENT: /, "agent: ").slice(0, 300)}`);
        } else if (/^AGENT: .*(bad signature|invalid domain|invalid mesh|WSERR|Duplicate agent|in big trouble)/.test(line)) {
          log.warn(`Remote access: ${line.replace(/^AGENT: /, "agent refused: ").slice(0, 300)}`);
        } else if (/^AGENT: /.test(line)) {
          // the rest of the agent chatter stays out of the log
        } else if (/error|failed|bad signature|holding connection/i.test(line)) log.warn(`Remote access: ${line.slice(0, 300)}`);
      }
    };
    p.stdout.on("data", onLine);
    p.stderr.on("data", onLine);
    p.on("exit", (code) => {
      if (child === p) {
        child = null;
        ready = false;
      }
      if (stopping || p.intended) return;
      error = `MeshCentral stopped (exit ${code})`;
      restarts += 1;
      log.warn(`Remote access: ${error}; starting it again`);
      setTimeout(() => sync().catch(() => {}), Math.min(5 * 60_000, 5000 * restarts)).unref();
    });
  }

  // MeshCentral reads the site's certificate when it starts: restart it to read it again, at most
  // once every 10 minutes (an agent that keeps seeing another one can't make it restart in a loop)
  let lastReload = 0;
  function reloadCert() {
    if (Date.now() - lastReload < 10 * 60_000 || !child) return;
    lastReload = Date.now();
    log.info("Remote access: an agent saw a different certificate; restarting MeshCentral to read the current one");
    stopChild().then(() => sync()).catch(() => {});
  }

  // Stops it, and waits until it's gone (its port must be free before another one starts)
  function stopChild() {
    if (!child) return Promise.resolve();
    const p = child;
    child = null;
    ready = false;
    runningFor = null;
    p.intended = true;
    return new Promise((resolve) => {
      const force = setTimeout(() => p.kill("SIGKILL"), 10_000);
      p.once("exit", () => (clearTimeout(force), resolve()));
      p.kill("SIGTERM");
    });
  }

  // Running when (and only when) there's a working domain, with that domain's settings
  let syncing = null;
  function sync() {
    if (!syncing) syncing = syncNow().finally(() => (syncing = null));
    return syncing;
  }
  async function syncNow() {
    if (stopping) return;
    const domain = address?.liveDomain?.() ?? null;
    if (!installed() || !domain) {
      if (child) {
        log.info("Remote access: off (no working domain)");
        await stopChild();
      }
      return;
    }
    if (child && runningFor === domain) {
      if (Date.now() - certCheckedAt > CERT_CHECK_MS) {
        certCheckedAt = Date.now();
        const fp = await certFingerprint(domain);
        if (fp && certSeen && fp !== certSeen) {
          log.info("Remote access: the site's certificate was renewed; restarting MeshCentral to use it");
          await stopChild();
        } else return;
      } else return;
    }
    if (child) await stopChild();
    try {
      await prepare(domain);
      certSeen = await certFingerprint(domain);
      certCheckedAt = Date.now();
      startChild(domain);
    } catch (err) {
      error = err.message;
      log.warn(`Remote access: couldn't start MeshCentral (${err.message})`);
    }
  }

  // The device group for a client, made the first time it's needed
  async function groupFor(clientName) {
    const known = q.group.get(clientName)?.mesh_id;
    if (known) return known;
    const out = await meshctrl(["adddevicegroup", "--name", clientName, "--desc", `Client: ${clientName}`]);
    const id = out.match(/ok (mesh\/\S+)/)?.[1];
    if (!id) throw new Error(`MeshCentral didn't make the group: ${out.slice(0, 200)}`);
    q.addGroup.run(clientName, id);
    // Everyone who has remote access sees every client's devices
    for (const u of await people().catch(() => [])) {
      await meshctrl(["addusertodevicegroup", "--id", id, "--userid", u, "--fullrights"]).catch(() => {});
    }
    return id;
  }

  async function people() {
    const users = await meshctrl(["listusers"], { json: true });
    return users.map((u) => u._id).filter((id) => id !== `user/${DOMAIN}/${SERVICE_USER}`);
  }

  // MeshCentral's devices, refreshed at most once a minute
  async function allNodes() {
    if (Date.now() - nodesAt < NODES_MS) return nodes;
    nodes = await meshctrl(["listdevices"], { json: true });
    nodesAt = Date.now();
    return nodes;
  }

  // The MeshCentral device for a gateway device: in its client's group, with the same name as the
  // device has in the gateway, or as the computer calls itself (from its health report)
  async function nodeFor(device, hostname = null) {
    const known = q.node.get(device.id)?.node_id;
    if (known) return known;
    const meshId = q.group.get(device.client_name)?.mesh_id;
    if (!meshId) return null;
    const inGroup = (await allNodes()).filter((n) => n.meshid === meshId);
    const match = inGroup.find((n) => sameName(n.name, device.device_name)) ?? (hostname ? inGroup.find((n) => sameName(n.name, hostname)) : null);
    if (!match) return null;
    q.setNode.run(device.id, match._id);
    return match._id;
  }

  return {
    REMOTE_PORT,
    start() {
      sync().catch(() => {});
      timer = setInterval(() => sync().catch(() => {}), WATCH_MS);
      timer.unref();
    },
    stop() {
      stopping = true;
      clearInterval(timer);
      stopChild();
    },
    // Ready for a browser or an agent right now
    isRunning: () => !!child && ready,

    status() {
      const domain = address?.liveDomain?.() ?? null;
      return {
        installed: installed(),
        domain,
        running: !!child && ready,
        url: domain ? `https://${domain}${REMOTE_PATH}/` : null,
        error,
      };
    },

    // For the install command: where the device's remote agent connects, and its client's group
    async installInfo(clientName) {
      if (!child || !ready) return null;
      const meshId = await groupFor(clientName);
      return { url: `https://${runningFor}${REMOTE_PATH}`, meshId: meshId.split("/").pop(), meshIdHex: idToHex(meshId) };
    },

    // Links that open the device in a new tab: desktop, terminal, files. null if it has no remote agent.
    async links(device, hostname = null) {
      if (!child || !ready) return null;
      const id = await nodeFor(device, hostname).catch(() => null);
      if (!id) return null;
      const base = `https://${runningFor}${REMOTE_PATH}/?gotonode=${idToHex(id)}`;
      return { desktop: `${base}&viewmode=11`, terminal: `${base}&viewmode=12`, files: `${base}&viewmode=13` };
    },

    // A person's own remote-access account (same name as in the gateway), with access to every
    // client's devices. (The gateway's sign-in, with its two-factor, comes first: server.js.)
    async setPassword(username, password) {
      if (!child || !ready) throw new Error("Remote access isn't running: set up the domain on Domain & SSL first.");
      if (String(password).length < 12) throw new Error("Use at least 12 characters.");
      const userid = `user/${DOMAIN}/${String(username).toLowerCase()}`;
      const existing = (await people()).includes(userid);
      if (existing) await meshctrl(["removeuser", "--userid", userid]);
      const out = await meshctrl(["adduser", "--user", username, "--pass", password]);
      if (!/ok/i.test(out)) throw new Error(`MeshCentral didn't take it: ${out.slice(0, 200)}`);
      // Every client's group MeshCentral has (not only the ones this gateway made)
      const groups = await meshctrl(["listdevicegroups"], { json: true }).catch(() => q.groups.all().map((g) => ({ _id: g.mesh_id })));
      for (const g of groups) {
        await meshctrl(["addusertodevicegroup", "--id", g._id, "--userid", userid, "--fullrights"]).catch(() => {});
      }
      security?.event("high", "admin.remote-access", `${username} ${existing ? "changed their" : "set up"} remote access password`, { detail: { username } });
      return { url: `https://${runningFor}${REMOTE_PATH}/`, user: username };
    },
  };
}
