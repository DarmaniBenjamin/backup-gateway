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

// Creates and stores a new code. The plain code is returned once and never stored.
export function createEnrollmentCode(db, clientName, ttlMinutes) {
  const name = String(clientName ?? "").trim();
  if (name.length < 1 || name.length > 100) throw new Error("Client name must be 1-100 characters.");
  const code = generateCode();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  db.addCode(hashCode(code), name, expiresAt.toISOString());
  return { code, clientName: name, expiresAt };
}