// Password hashing with scrypt (built into Node). scrypt is "memory-hard": every guess costs an
// attacker real memory and time, so stolen hashes are very slow to crack.
// Stored format: scrypt$N$r$p$salt$hash  (salt and hash in base64)

import crypto from "node:crypto";

const N = 2 ** 15; // cost
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEM = 128 * N * R * 2;

function scrypt(password, salt, n, r, p) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: Math.max(MAX_MEM, 128 * n * r * 2) }, (err, key) =>
      err ? reject(err) : resolve(key)
    );
  });
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Used when a username doesn't exist, so the response takes the same time either way
// (otherwise attackers could tell which usernames are real).
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString("hex"));
export function burnTime(password) {
  return verifyPassword(password, DUMMY_HASH);
}

export function checkPasswordStrength(password) {
  if (typeof password !== "string" || password.length < 12) return "Password must be at least 12 characters.";
  if (password.length > 200) return "Password is too long.";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (kinds < 3) return "Use at least 3 of: lowercase, uppercase, numbers, symbols.";
  return null;
}