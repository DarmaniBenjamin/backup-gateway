// The admin web server: serves the web UI and the admin API on a SEPARATE port from the agents.
// Its own port stays on 127.0.0.1. From other computers the web UI is reached through the agent
// port (server.js): on the gateway's IP addresses until it has a domain, then only at
// https://<domain> (opening it by IP is blocked from then on).
//
// Protections:
//   - Session cookie is HttpOnly (JavaScript can't read it) and SameSite=Strict (other sites can't use it)
//   - Every API call that changes something must carry the X-Backup-UI header, which other
//     websites can't add to cross-site requests (CSRF protection)
//   - Strict security headers on every response (no framing, no outside scripts)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createAdminApi, ApiError } from "./api.js";
import { SESSION_MAX_MS } from "./admin-store.js";
import { log } from "../logger.js";

const COOKIE = "bg_session";
const MAX_BODY = 64 * 1024;
const UI_DIR = fileURLToPath(new URL("../../ui/dist/", import.meta.url));

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// The Google folder picker window (google-picker.html) is the ONE page allowed to load Google's
// script: it runs in its own small window, so the rest of the admin UI keeps the strict policy above.
const PICKER_HEADERS = {
  ...SECURITY_HEADERS,
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com; " +
    "font-src 'self'; script-src 'self' https://apis.google.com https://www.gstatic.com; " +
    "frame-src https://docs.google.com https://drive.google.com; connect-src 'self' https://apis.google.com https://www.googleapis.com; " +
    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "Referrer-Policy": "strict-origin",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
};

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, "Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      if (size === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ApiError(400, "Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

// Which compression the browser takes: Brotli (smallest), else gzip, else none
function pickEncoding(req) {
  const accepted = String(req?.headers["accept-encoding"] ?? "");
  if (/\bbr\b/.test(accepted)) return "br";
  if (/\bgzip\b/.test(accepted)) return "gzip";
  return null;
}

function sendJson(res, status, data, extraHeaders = {}, req = null) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { ...SECURITY_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store", Vary: "Accept-Encoding" };
  // Big answers (file lists, activity) go out gzipped: much less to send when the UI is used over a network
  if (body.length > 4096 && pickEncoding(req)) {
    body = zlib.gzipSync(body, { level: 4 });
    headers["Content-Encoding"] = "gzip";
  }
  res.writeHead(status, { ...headers, "Content-Length": body.length, ...extraHeaders });
  res.end(body);
}

// The built web UI, kept in memory already compressed. Files are read and compressed once, the
// first time they're asked for, and again only if they change on disk (after a new build).
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json", ".ico"]);
const staticCache = new Map();

function loadStatic(filePath) {
  const stat = fs.statSync(filePath);
  const cached = staticCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;
  const raw = fs.readFileSync(filePath);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, raw, etag: `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"` };
  if (COMPRESSIBLE.has(path.extname(filePath)) && raw.length > 1024) {
    entry.br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
    });
    entry.gzip = zlib.gzipSync(raw, { level: 9 });
  }
  staticCache.set(filePath, entry);
  return entry;
}

// Compress the UI files in the background at startup, so even the first page load is quick
function warmStatic() {
  const assets = path.join(UI_DIR, "assets");
  const files = [path.join(UI_DIR, "index.html")];
  if (fs.existsSync(assets)) for (const name of fs.readdirSync(assets)) files.push(path.join(assets, name));
  const next = () => {
    const f = files.shift();
    if (!f) return;
    try {
      if (fs.existsSync(f)) loadStatic(f);
    } catch {
      // served (and reported) when it's actually asked for
    }
    setImmediate(next);
  };
  setImmediate(next);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(path.join(UI_DIR, "index.html"))) {
    const body = "<h1>Backup Gateway</h1><p>The web UI hasn't been built yet. Run <code>npm run build</code> in gateway/ui.</p>";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    return res.end(body);
  }
  // Resolve safely inside UI_DIR; anything unknown falls back to index.html (single-page app)
  let filePath;
  try {
    filePath = path.resolve(UI_DIR, "." + decodeURIComponent(pathname));
  } catch {
    filePath = "";
  }
  if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIR, "index.html");
  }
  const file = loadStatic(filePath);
  const ext = path.extname(filePath);
  const headers = {
    ...(path.basename(filePath) === "google-picker.html" ? PICKER_HEADERS : SECURITY_HEADERS),
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    ETag: file.etag,
    Vary: "Accept-Encoding",
  };
  if (req.headers["if-none-match"] === file.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  const encoding = file.br ? pickEncoding(req) : null;
  const body = encoding ? file[encoding] : file.raw;
  if (encoding) headers["Content-Encoding"] = encoding;
  headers["Content-Length"] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

export function createAdminServer({ db, store, keys, storage, config, broker, installs, copies, security, scanner, updates, notify, health, removals, address, lockdown = null }) {
  const matchRoute = createAdminApi({ db, store, keys, storage, config, broker, installs, copies, security, scanner, updates, notify, health, removals, address, lockdown });
  warmStatic();

  // ip: the caller's real address when the request came through the agent port (server.js)
  async function handle(req, res, ip = req.socket.remoteAddress) {
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

    // Back from Google's sign-in page (Google Drive copy): finish, then show the Off-site page
    if (pathname === "/admin/oauth/google" && req.method === "GET") {
      let to = "/offsite";
      try {
        to = await matchRoute.oauthCallback(Object.fromEntries(url.searchParams), ip);
      } catch (err) {
        log.error("Google sign-in error", err);
      }
      res.writeHead(303, { ...SECURITY_HEADERS, Location: to, "Cache-Control": "no-store" });
      return res.end();
    }

    if (!pathname.startsWith("/admin/api/")) {
      if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed" });
      return serveStatic(req, res, pathname);
    }

    try {
      const route = matchRoute(req.method, pathname.slice("/admin/api".length));
      if (!route) throw new ApiError(404, "Not found");

      // CSRF protection for anything that changes data
      if (req.method !== "GET" && req.headers["x-backup-ui"] !== "1") {
        throw new ApiError(403, "Missing X-Backup-UI header");
      }

      const cookies = parseCookies(req.headers.cookie);
      const session = store.findSession(cookies[COOKIE]);
      if (!route.isLogin && !session) throw new ApiError(401, "Not logged in");

      const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
      const cookieBase = `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
      const extraHeaders = {};

      const result = await route.handler({
        admin: session ? { id: session.admin_id, username: session.username } : null,
        params: route.params,
        query: Object.fromEntries(url.searchParams),
        host: req.headers.host,
        body: req.method === "GET" ? {} : await readJsonBody(req),
        ip,
        setSession(adminId) {
          if (session) store.deleteSession(cookies[COOKIE]);
          const token = store.createSession(adminId, ip, req.headers["user-agent"]);
          extraHeaders["Set-Cookie"] = `${COOKIE}=${token}; ${cookieBase}; Max-Age=${SESSION_MAX_MS / 1000}`;
        },
        clearSession() {
          store.deleteSession(cookies[COOKIE]);
          extraHeaders["Set-Cookie"] = `${COOKIE}=; ${cookieBase}; Max-Age=0`;
        },
      });
      return sendJson(res, 200, result ?? null, extraHeaders, req);
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message });
      log.error("Admin API error", err);
      return sendJson(res, 500, { error: "Internal error" });
    }
  }

  const server = http.createServer((req, res) => handle(req, res));
  server.handle = handle;
  return server;
}