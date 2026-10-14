// Two-factor login with an authenticator app (Google Authenticator, Microsoft Authenticator,
// 1Password, Authy...): the standard 6-digit codes that change every 30 seconds (RFC 6238).
// A code can be used once only, and the one before and after are also accepted, for clocks a
// little off. Recovery codes, for a lost phone, also work once each; only their hashes are kept.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_S = 30;

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new secret: 20 random bytes, as the authenticator app expects them (base32)
export const newSecret = () => base32Encode(crypto.randomBytes(20));

// The code for one 30-second step
export function codeAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

export const counterNow = (now = Date.now()) => Math.floor(now / 1000 / STEP_S);

// Checks a typed code. Returns the step it matched (to remember, so it can't be used again), or null.
// lastUsed: the step of the last code accepted for this admin.
export function verifyCode(secret, typed, lastUsed = -1, now = Date.now()) {
  const code = String(typed ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const c = counterNow(now);
  for (const step of [c - 1, c, c + 1]) {
    if (step <= lastUsed) continue;
    const want = Buffer.from(codeAt(secret, step));
    if (crypto.timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

// The link an authenticator app reads (from the QR code, or tapped on a phone)
export function otpauthUrl(secret, username, issuer = "Backup Gateway") {
  const label = encodeURIComponent(`${issuer}:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_S}`;
}

// Recovery codes: 10 of them, like 7KQ2-M9XD, each usable once
const RC_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0/O, 1/I
export function newRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(8);
    const s = [...bytes].map((b) => RC_ALPHABET[b & 31]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
const cleanRecovery = (code) => String(code ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "");
export const hashRecoveryCode = (code) => crypto.createHash("sha256").update(cleanRecovery(code)).digest("hex");
export const looksLikeRecoveryCode = (code) => cleanRecovery(code).length === 8;
