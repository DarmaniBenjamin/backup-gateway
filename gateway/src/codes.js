// One-time enrollment codes. Format: XXXX-XXXX-XXXX (about 60 bits of randomness).
// Letters/numbers that look alike (0/O, 1/I/L) are left out so codes are easy to type.

import crypto from "node:crypto";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateCode() {
  const chars = [];
  for (let i = 0; i < 12; i++) chars.push(ALPHABET[crypto.randomInt(ALPHABET.length)]);
  const raw = chars.join("");
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// Codes are stored only as SHA-256 hashes, so a stolen database doesn't reveal working codes
export function hashCode(code) {
  const normalized = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}