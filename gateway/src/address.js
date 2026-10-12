// The gateway's address on the internet, with its https certificate (web UI: Certificate page).
// Devices at client sites connect to this address. Two ways:
//
// 1. Caddy, for a server with its own public IP (a cloud VM). You type the domain, point its DNS
//    A record at the server, and Caddy gets a free Let's Encrypt certificate and renews it by
//    itself. Caddy is set up from here through its settings API on this computer
//    (http://127.0.0.1:2019): when this starts, when the address changes, and every 30 seconds,
//    so a restarted Caddy gets its settings back. Caddy only gets a certificate for this one
//    domain: before asking Let's Encrypt it checks with the gateway (GET /api/caddy/allowed).
//    A Caddy that's already used by something else on this computer (Uplink, say) is left alone.
//
// 2. A Cloudflare Tunnel, for a machine on site: no port to open anywhere. You make the tunnel in
//    the Cloudflare dashboard, with a public hostname whose service is http://localhost:8080, and
//    paste its token here. The gateway runs cloudflared itself (installed by deploy/install.sh),
//    with the token in its environment (never on its command line, where other users could see
//    it) and restarts it if it stops.
//
// Either way, only the agent port (8080) is reachable through it: the web UI stays on this
// computer. Devices are only given the new address (the install links) once it's checked to work
// end to end: DNS, a valid certificate, and the address really reaching this gateway (it answers
// with a random ID made when the gateway started). Until then they keep GATEWAY_PUBLIC_URL from
// .env, or this computer's own address. Devices already installed keep the address they were
// installed with.
//
// The token is kept in the gateway's database and never sent to the web UI or the audit log.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { Resolver } from "node:dns/promises";
import { DatabaseSync } from "node:sqlite";
import { log } from "./logger.js";

export class AddressError extends Error {}

// Answered at GET /api/hello on the agent port: proof that an address reaches this gateway
export const HELLO_ID = crypto.randomBytes(16).toString("hex");

const CADDY_ADMIN = (process.env.GATEWAY_CADDY_ADMIN || "http://127.0.0.1:2019").replace(/\/+$/, "");
const TUNNEL_METRICS = process.env.GATEWAY_TUNNEL_METRICS || "127.0.0.1:20241";
const ID = "backup-gateway"; // marks Caddy's settings as ours
const SYNC_MS = 30_000;
const LIVE_CHECK_MS = 10 * 60_000;

// "https://Backup.Example.com/" -> "backup.example.com"
export function cleanDomain(value) {
  const name = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
  const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
  if (!name || name.length > 253 || !new RegExp(`^(?:${label}\\.)+[a-z]{2,63}$`).test(name)) {
    throw new AddressError("Enter an address like backup.yourcompany.com.");
  }
  return name;
}

// The token from the Cloudflare dashboard. People often copy the whole install command
// ("cloudflared service install eyJ..."), so the token is picked out of whatever was pasted.
export function cleanToken(value) {
  const token = String(value ?? "").match(/eyJ[A-Za-z0-9+/_=-]{40,}/)?.[0];
  if (!token) throw new AddressError("That doesn't look like a tunnel token. Copy it from the Cloudflare dashboard (it starts with eyJ).");
  let info;
  try {
    info = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    info = null;
  }
  if (!info?.t || !info?.s) throw new AddressError("That tunnel token isn't complete. Copy it again from the Cloudflare dashboard.");
  return { token, tunnelId: String(info.t) };
}

// What the domain points to, asked of public DNS servers (not this computer's cache)
async function publicDns(name) {
  const resolver = new Resolver({ timeout: 3000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  const [cname, a] = await Promise.all([resolver.resolveCname(name).catch(() => []), resolver.resolve4(name).catch(() => [])]);
  return [...cname.map((value) => ({ type: "CNAME", value })), ...a.map((value) => ({ type: "A", value }))];
}

const CERT_PROBLEMS = {
  ENOTFOUND: "The address doesn't point anywhere yet.",
  EAI_AGAIN: "The address doesn't point anywhere yet.",
  ECONNREFUSED: "Nothing answered on port 443 yet.",
  ETIMEDOUT: "Nothing answered yet.",
  TIMEOUT: "Nothing answered yet.",
  CERT_HAS_EXPIRED: "The certificate has run out.",
};

// Connects to https://name like a browser would and checks the certificate is real and for this name
function checkCertificate(name, ip) {
  return new Promise((resolve) => {
    let done = false;
    const socket = tls.connect({ host: ip || name, port: 443, servername: name, timeout: 10_000 }, () => {
      const cert = socket.getPeerCertificate();
      finish({ secure: true, issuer: cert?.issuer?.O ?? null, expiresAt: cert?.valid_to ? Date.parse(cert.valid_to) : null });
    });
    function finish(result) {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    }
    socket.on("timeout", () => finish({ secure: false, problem: CERT_PROBLEMS.TIMEOUT }));
    socket.on("error", (err) =>
      finish({ secure: false, problem: CERT_PROBLEMS[err.code] ?? "The certificate for this address isn't there yet." })
    );
  });
}

// Does https://name reach this gateway? (It answers /api/hello with this run's ID.)
function reachesUs(name, ip) {
  return new Promise((resolve) => {
    const req = https.get(
      { host: ip || name, servername: name, port: 443, path: "/api/hello", headers: { Host: name }, timeout: 10_000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (body.length < 4096 ? (body += d) : null));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body)?.id === HELLO_ID);
          } catch {
            resolve(false);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

let ipCache = { ip: null, at: 0 };
async function serverIp() {
  if (process.env.GATEWAY_SERVER_IP) {
    ipCache = { ip: process.env.GATEWAY_SERVER_IP.trim(), at: Date.now() };
    return ipCache.ip;
  }
  if (ipCache.ip && Date.now() - ipCache.at < 60 * 60_000) return ipCache.ip;
  for (const url of ["https://api.ipify.org", "https://checkip.amazonaws.com"]) {
    try {
      const ip = (await (await fetch(url, { signal: AbortSignal.timeout(4000) })).text()).trim();
      if (net.isIPv4(ip)) {
        ipCache = { ip, at: Date.now() };
        return ip;
      }
    } catch {
      // the next one
    }
  }
  return null;
}

function findProgram(name) {
  for (const dir of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":")) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

export function createAddress({ dataDir, config, security = null }) {
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  conn.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS address_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const q = {
    get: conn.prepare("SELECT value FROM address_settings WHERE name = 'address'"),
    set: conn.prepare("INSERT OR REPLACE INTO address_settings (name, value) VALUES ('address', ?)"),
    clear: conn.prepare("DELETE FROM address_settings WHERE name = 'address'"),
  };
  // { mode: "caddy" | "tunnel", domain, email, token, tunnelId, since, live, liveSince }
  const load = () => {
    try {
      return JSON.parse(q.get.get()?.value ?? "null");
    } catch {
      return null;
    }
  };
  const save = (s) => q.set.run(JSON.stringify(s));

  const envUrl = config.publicUrl; // GATEWAY_PUBLIC_URL from .env (or null)
  let checks = null; // the last check: { at, dns, serverIp, certificate, reaches }
  let caddy = { reachable: false, configured: false, foreign: false, error: null };
  let lastSent = null;
  let tunnel = { proc: null, connected: false, error: null, startedAt: null, restartTimer: null };
  let checking = null;

  // Devices get the address only once it works
  function apply(s = load()) {
    config.publicUrl = s?.live ? `https://${s.domain}` : envUrl;
  }

  // ---------- Caddy ----------

  async function caddyApi(p, { method = "GET", body } = {}) {
    const { origin } = new URL(CADDY_ADMIN);
    return fetch(`${CADDY_ADMIN}${p}`, {
      method,
      headers: { Origin: origin, ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      signal: AbortSignal.timeout(5000),
    });
  }

  function caddyConfig(s) {
    const upstream = `127.0.0.1:${config.port}`;
    const say = (status, text) => ({ handler: "static_response", status_code: status, headers: { "Content-Type": ["text/plain; charset=utf-8"] }, body: text });
    const issuer = { module: "acme", ...(s.email ? { email: s.email } : {}) };
    return {
      apps: {
        http: {
          servers: {
            [ID]: {
              "@id": ID,
              listen: [":443"],
              routes: [
                { match: [{ host: [s.domain] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: upstream }] }] },
                { handle: [say(404, "Not set up on this gateway.\n")] },
              ],
              tls_connection_policies: [{}],
              automatic_https: { disable_redirects: true },
            },
            [`${ID}-http`]: {
              listen: [":80"],
              routes: [
                {
                  match: [{ host: [s.domain] }],
                  handle: [{ handler: "static_response", status_code: 308, headers: { Location: ["https://{http.request.host}{http.request.uri}"] } }],
                },
                { handle: [say(404, "Not set up on this gateway.\n")] },
              ],
            },
          },
        },
        tls: {
          automation: {
            policies: [{ issuers: [issuer], on_demand: true }],
            on_demand: { permission: { module: "http", endpoint: `http://${upstream}/api/caddy/allowed` } },
          },
        },
      },
    };
  }

  // Is this computer's Caddy already doing something else (Uplink, a website)? Then hands off.
  function foreignConfig(current) {
    const servers = current?.apps?.http?.servers ?? {};
    return Object.entries(servers).some(([key, server]) => {
      if (key === ID || key === `${ID}-http`) return false;
      const text = JSON.stringify(server);
      return text.includes('"reverse_proxy"') || text.includes('"helpdesk"');
    });
  }

  async function syncCaddy({ force = false } = {}) {
    const s = load();
    if (s?.mode !== "caddy") return caddy;
    try {
      const body = JSON.stringify(caddyConfig(s));
      if (!force && body === lastSent && (await caddyApi(`/id/${ID}`)).ok) {
        caddy = { reachable: true, configured: true, foreign: false, error: null };
        return caddy;
      }
      const current = await (await caddyApi("/config/")).json().catch(() => null);
      if (foreignConfig(current)) {
        caddy = { reachable: true, configured: false, foreign: true, error: null };
        lastSent = null;
        return caddy;
      }
      const res = await caddyApi("/load", { method: "POST", body });
      if (!res.ok) {
        caddy = { reachable: true, configured: false, foreign: false, error: (await res.text().catch(() => "")).slice(0, 300) || `Caddy answered ${res.status}` };
        return caddy;
      }
      if (!caddy.configured) log.info(`Caddy is set up for https://${s.domain}`);
      lastSent = body;
      caddy = { reachable: true, configured: true, foreign: false, error: null };
    } catch {
      lastSent = null;
      caddy = { reachable: false, configured: false, foreign: false, error: null };
    }
    return caddy;
  }

  // Our settings out of Caddy (when the address is removed or changed to a tunnel)
  async function clearCaddy() {
    lastSent = null;
    try {
      const current = await (await caddyApi("/config/")).json().catch(() => null);
      if (current && !foreignConfig(current) && current?.apps?.http?.servers?.[ID]) {
        await caddyApi("/load", { method: "POST", body: JSON.stringify({}) });
      }
    } catch {
      // Caddy isn't there
    }
    caddy = { reachable: false, configured: false, foreign: false, error: null };
  }

  // ---------- Cloudflare Tunnel ----------

  function stopTunnel() {
    clearTimeout(tunnel.restartTimer);
    const proc = tunnel.proc;
    tunnel = { proc: null, connected: false, error: null, startedAt: null, restartTimer: null };
    if (proc) proc.kill("SIGTERM");
  }

  function startTunnel() {
    const s = load();
    if (s?.mode !== "tunnel" || tunnel.proc) return;
    const program = findProgram("cloudflared");
    if (!program) {
      tunnel.error = "cloudflared isn't installed on this computer. Run deploy/install.sh again, or install it (Cloudflare's instructions).";
      return;
    }
    const lines = [];
    const proc = spawn(program, ["tunnel", "--no-autoupdate", "--metrics", TUNNEL_METRICS, "run"], {
      env: { PATH: process.env.PATH, HOME: dataDir, TUNNEL_TOKEN: s.token },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const keep = (d) => {
      for (const line of String(d).split("\n").filter(Boolean)) lines.push(line.slice(0, 300));
      lines.splice(0, Math.max(0, lines.length - 20));
    };
    proc.stdout.on("data", keep);
    proc.stderr.on("data", keep);
    tunnel = { proc, connected: false, error: null, startedAt: Date.now(), restartTimer: null };
    log.info("Cloudflare Tunnel started");
    proc.on("exit", (code) => {
      if (tunnel.proc !== proc) return; // stopped on purpose
      const err = lines.filter((l) => / ERR |error|Unauthorized|invalid/i.test(l)).pop() ?? `cloudflared stopped (code ${code})`;
      log.warn(`Cloudflare Tunnel stopped: ${err}`);
      tunnel = { proc: null, connected: false, error: err.replace(/^\S+\s+ERR\s+/, ""), startedAt: null, restartTimer: null };
      tunnel.restartTimer = setTimeout(startTunnel, 15_000);
      tunnel.restartTimer.unref?.();
    });
  }

  async function tunnelReady() {
    if (!tunnel.proc) return false;
    try {
      const res = await fetch(`http://${TUNNEL_METRICS}/ready`, { signal: AbortSignal.timeout(3000) });
      const data = await res.json().catch(() => ({}));
      tunnel.connected = res.ok && (data.readyConnections ?? 1) > 0;
    } catch {
      tunnel.connected = false;
    }
    return tunnel.connected;
  }

  // ---------- Checking it works ----------

  async function check() {
    if (checking) return checking;
    checking = (async () => {
      const s = load();
      if (!s) {
        checks = null;
        return;
      }
      if (s.mode === "caddy") await syncCaddy();
      if (s.mode === "tunnel") {
        startTunnel();
        await tunnelReady();
      }
      const [dns, ip] = await Promise.all([publicDns(s.domain), s.mode === "caddy" ? serverIp() : Promise.resolve(null)]);
      const firstIp = dns.find((r) => r.type === "A")?.value;
      const certificate = firstIp ? await checkCertificate(s.domain, firstIp) : { secure: false, problem: CERT_PROBLEMS.ENOTFOUND };
      const reaches = certificate.secure ? await reachesUs(s.domain, firstIp) : false;
      checks = { at: Date.now(), dns, serverIp: ip, certificate, reaches };

      const fresh = load();
      if (!fresh || fresh.domain !== s.domain || fresh.mode !== s.mode) return; // changed meanwhile
      if (reaches && !fresh.live) {
        fresh.live = true;
        fresh.liveSince = Date.now();
        save(fresh);
        apply(fresh);
        log.info(`Devices now get https://${fresh.domain} in their install links`);
        security?.event("info", "gateway.address-live", `The gateway's address https://${fresh.domain} works: new devices are installed with it`, {
          detail: { domain: fresh.domain, mode: fresh.mode },
        });
      }
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  function steps(s) {
    const c = checks;
    const dnsHere = s.mode === "caddy" ? !!c?.serverIp && !!c?.dns.some((r) => r.type === "A" && r.value === c.serverIp) : !!c?.dns.length;
    const list =
      s.mode === "caddy"
        ? [
            { id: "added", label: "Address added", done: true },
            { id: "dns", label: "DNS points here", done: dnsHere || !!s.live },
            { id: "certificate", label: "Certificate", done: !!c?.certificate.secure || !!s.live },
            { id: "live", label: "Devices use it", done: !!s.live },
          ]
        : [
            { id: "added", label: "Token added", done: true },
            { id: "tunnel", label: "Tunnel connected", done: tunnel.connected },
            { id: "certificate", label: "Certificate", done: !!c?.certificate.secure || !!s.live },
            { id: "live", label: "Devices use it", done: !!s.live },
          ];
    return list;
  }

  function view() {
    const s = load();
    const base = {
      mode: s?.mode ?? null,
      domain: s?.domain ?? null,
      email: s?.email ?? "",
      tunnelId: s?.tunnelId ?? null,
      hasToken: !!s?.token,
      live: !!s?.live,
      liveSince: s?.liveSince ?? null,
      since: s?.since ?? null,
      publicUrl: config.publicUrl,
      envUrl,
      agentPort: config.port,
      serverIp: checks?.serverIp ?? ipCache.ip,
      checkedAt: checks?.at ?? null,
      found: checks?.dns ?? [],
      certificate: checks?.certificate ?? null,
      reaches: checks?.reaches ?? false,
      caddy: { ...caddy, installed: !!findProgram("caddy") },
      tunnel: { connected: tunnel.connected, running: !!tunnel.proc, error: tunnel.error, installed: !!findProgram("cloudflared") },
      trustProxy: ["1", "true", "yes"].includes(String(process.env.GATEWAY_TRUST_PROXY ?? "").toLowerCase()),
    };
    return { ...base, steps: s ? steps(s) : [] };
  }

  apply();

  return {
    view,
    check,
    // This server's public IP (for the DNS record), looked up once an hour
    lookupIp: serverIp,
    // Caddy's question before it gets a certificate: only for our own domain
    allowed: (name) => {
      const s = load();
      return s?.mode === "caddy" && s.domain === String(name ?? "").toLowerCase();
    },

    async useCaddy({ domain, email }) {
      const name = cleanDomain(domain);
      const mail = String(email ?? "").trim();
      if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new AddressError("That email doesn't look right.");
      stopTunnel();
      const old = load();
      save({ mode: "caddy", domain: name, email: mail, since: Date.now(), live: old?.mode === "caddy" && old.domain === name && !!old.live, liveSince: old?.liveSince ?? null });
      apply();
      checks = null;
      const status = await syncCaddy({ force: true });
      if (status.foreign) {
        q.clear.run();
        apply();
        throw new AddressError("Caddy on this computer is already used by something else (Uplink?), so the gateway leaves it alone. Use a Cloudflare Tunnel instead, or put the gateway on its own server.");
      }
      if (!status.reachable) {
        q.clear.run();
        apply();
        throw new AddressError("Caddy isn't running on this computer. Run deploy/install.sh (choose online), or install Caddy, then try again.");
      }
      check().catch(() => {});
      return view();
    },

    async useTunnel({ token, domain }) {
      const name = cleanDomain(domain);
      const t = cleanToken(token);
      if (!findProgram("cloudflared")) throw new AddressError("cloudflared isn't installed on this computer. Run deploy/install.sh again (choose online).");
      const old = load();
      if (old?.mode === "caddy") await clearCaddy();
      stopTunnel();
      save({ mode: "tunnel", domain: name, token: t.token, tunnelId: t.tunnelId, since: Date.now(), live: false, liveSince: null });
      apply();
      checks = null;
      startTunnel();
      check().catch(() => {});
      return view();
    },

    async remove() {
      const s = load();
      if (s?.mode === "caddy") await clearCaddy();
      stopTunnel();
      q.clear.run();
      checks = null;
      apply(null);
      return view();
    },

    // When the gateway starts: Caddy's settings, the tunnel, then a check every 30 seconds while it's
    // being set up (every 10 minutes once it works)
    start() {
      const s = load();
      if (s?.mode === "caddy") syncCaddy({ force: true }).catch(() => {});
      if (s?.mode === "tunnel") startTunnel();
      let last = 0;
      const timer = setInterval(() => {
        const cur = load();
        if (!cur) return;
        if (cur.mode === "caddy") syncCaddy().catch(() => {});
        if (!cur.live || Date.now() - last > LIVE_CHECK_MS) {
          last = Date.now();
          check().catch(() => {});
        }
      }, SYNC_MS);
      timer.unref();
      setTimeout(() => check().catch(() => {}), 5000).unref();
      process.once("exit", stopTunnel);
    },
  };
}
