// The recovery key: what lets you rebuild the gateway from the cloud if it's lost or destroyed.
//
// It's an X25519 key pair made when off-site backups are connected. The gateway keeps only the
// PUBLIC half, which can lock (encrypt) the catalog it uploads but can't unlock it. The private
// half is shown to you once as the recovery key, e.g. BGRK-7Q2M-…; keep it offline (printed, or
// in a password manager). With it and the bucket's access key, the recover tool brings back
// every device's files. Without it, what's in the bucket can't be read by anyone.
//
// Catalog box layout: ["BGCAT1"][32-byte one-time public key][12-byte nonce][ciphertext][16-byte tag]

import crypto from "node:crypto";

const MAGIC = Buffer.from("BGCAT1");
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // base32

function base32(buf) {
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

function unbase32(str) {
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of str) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("bad character");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const rawPublic = (key) => Buffer.from(crypto.createPublicKey(key).export({ format: "jwk" }).x, "base64url");
const publicFromRaw = (raw) => crypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw.toString("base64url") }, format: "jwk" });
// A raw 32-byte X25519 private key wrapped in its standard PKCS#8 envelope
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const privateFromRaw = (raw) => crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });

// Short fingerprint to tell recovery keys apart, e.g. "3F9A-C1D2"
export function fingerprint(publicRaw) {
  const h = crypto.createHash("sha256").update(publicRaw).digest("hex").slice(0, 8).toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

// Makes a new recovery key. Returns the text to show once, and the public half (base64) to keep.
export function createRecoveryKey() {
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d, "base64url");
  const check = crypto.createHash("sha256").update(d).digest().subarray(0, 2); // catches typing mistakes
  const text = base32(Buffer.concat([d, check])); // 55 characters
  const groups = text.match(/.{1,4}/g).join("-");
  const publicRaw = rawPublic(privateKey);
  return { recoveryKey: `BGRK-${groups}`, publicKey: publicRaw.toString("base64"), fingerprint: fingerprint(publicRaw) };
}

// Reads a recovery key typed or pasted by a person (spaces, dashes and case don't matter)
export function parseRecoveryKey(text) {
  const clean = String(text ?? "").toUpperCase().replace(/[^A-Z2-7]/g, "").replace(/^BGRK/, "");
  let raw;
  try {
    raw = unbase32(clean);
  } catch {
    raw = Buffer.alloc(0);
  }
  if (raw.length !== 34) throw new Error("That isn't a complete recovery key. It starts with BGRK- and has 14 groups.");
  const d = raw.subarray(0, 32);
  const check = crypto.createHash("sha256").update(d).digest().subarray(0, 2);
  if (!check.equals(raw.subarray(32))) throw new Error("That recovery key has a typing mistake in it (its check digits don't match).");
  const privateKey = privateFromRaw(d);
  const publicRaw = rawPublic(privateKey);
  return { privateKey, fingerprint: fingerprint(publicRaw) };
}

function boxKey(shared, ephemeralRaw, recipientRaw) {
  return Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.concat([ephemeralRaw, recipientRaw]), Buffer.from("backup-gateway catalog v1"), 32)
  );
}

// Encrypt a catalog so only the recovery key can open it
export function sealForRecovery(publicKeyBase64, plaintext) {
  const recipientRaw = Buffer.from(publicKeyBase64, "base64");
  const { privateKey: ephemeral } = crypto.generateKeyPairSync("x25519");
  const ephemeralRaw = rawPublic(ephemeral);
  const shared = crypto.diffieHellman({ privateKey: ephemeral, publicKey: publicFromRaw(recipientRaw) });
  const key = boxKey(shared, ephemeralRaw, recipientRaw);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.concat([MAGIC, ephemeralRaw]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, ephemeralRaw, nonce, ciphertext, cipher.getAuthTag()]);
}

export function openWithRecoveryKey(privateKey, box) {
  if (box.length < 6 + 32 + 12 + 16 || !box.subarray(0, 6).equals(MAGIC)) throw new Error("Not a gateway catalog");
  const ephemeralRaw = box.subarray(6, 38);
  const nonce = box.subarray(38, 50);
  const tag = box.subarray(box.length - 16);
  const ciphertext = box.subarray(50, box.length - 16);
  const shared = crypto.diffieHellman({ privateKey, publicKey: publicFromRaw(ephemeralRaw) });
  const key = boxKey(shared, ephemeralRaw, rawPublic(privateKey));
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.concat([MAGIC, ephemeralRaw]));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("This recovery key doesn't open the catalog (wrong key, or the catalog was damaged).");
  }
}
