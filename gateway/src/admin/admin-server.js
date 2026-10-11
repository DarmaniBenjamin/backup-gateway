// The admin web server: serves the web UI and the admin API on a SEPARATE port from the agents.
// Bind it to 127.0.0.1 (or a management VLAN) only — it should never be reachable from the internet.
//
// Protections:
//   - Session cookie is HttpOnly (JavaScript can't read it) and SameSite=Strict (other sites can't use it)
//   - Every API call that changes something must carry the X-Backup-UI header, which other
//     websites can't add to cross-site requests (CSRF protection)
//   - Strict security headers on every response (no framing, no outside scripts)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
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

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(path.join(UI_DIR, "index.html"))) {
    const body = "<h1>Backup Gateway</h1><p>The web UI hasn't been built yet. Run <code>npm run build</code> in gateway/ui.</p>";
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
    return res.end(body);
  }
  // Resolve safely inside UI_DIR; anything unknown falls back to index.html (single-page app)
  let filePath = path.resolve(UI_DIR, "." + decodeURIComponent(pathname));
  if (!filePath.startsWith(UI_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(UI_DIR, "index.html");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": MIME[ext] ?? "application/octet-stream",
    "Cache-Control": filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
  });
  fs.createReadStream(filePath).pipe(res);
}

export function createAdminServer({ db, store, keys, storage, config, broker, installs, offsite }) {
  const matchRoute = createAdminApi({ db, store, keys, storage, config, broker, installs, offsite });

  return http.createServer(async (req, res) => {
    const ip = req.socket.remoteAddress;
    const url = new URL(req.url, "http://localhost");
    const pathname = url.pathname;

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
      return sendJson(res, 200, result ?? null, extraHeaders);
    } catch (err) {
      if (err instanceof ApiError) return sendJson(res, err.status, { error: err.message });
      log.error("Admin API error", err);
      return sendJson(res, 500, { error: "Internal error" });
    }
  });
}