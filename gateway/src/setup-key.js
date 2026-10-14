// The one-time setup link: before the gateway has its domain, the web UI on its IP address only opens
// for someone who has the link the installer printed (http://<IP>/?setup=<key>). Anyone else who finds
// the IP sees a page saying so. The browser that opened the link keeps a cookie for 30 days.
// Once the domain works, the web UI is only on https://<domain> and this isn't needed any more.
//
// Print the link again on the server: cd gateway && npm run setup-link

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SETUP_COOKIE = "bg_setup";
const FILE = "web-setup-key";

export function loadOrCreateSetupKey(dataDir) {
  const file = path.join(dataDir, FILE);
  try {
    const key = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{32,}$/.test(key)) return key;
  } catch {
    // not made yet
  }
  const key = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, key + "\n", { mode: 0o600 });
  return key;
}

// What the browser keeps: derived from the key, so the key itself isn't stored in the cookie
export const setupCookieValue = (key) => crypto.createHmac("sha256", key).update("web-ui setup cookie v1").digest("base64url");

function same(a, b) {
  const x = Buffer.from(String(a ?? ""));
  const y = Buffer.from(String(b ?? ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export const isSetupKey = (key, typed) => same(key, typed);
export const isSetupCookie = (key, value) => same(setupCookieValue(key), value);
