// Encryption format shared by the agent and the gateway (this file is identical in both).
//
// Keys: the agent and gateway each have an X25519 key pair. They combine them (ECDH) into a
// shared secret that only they can compute, then derive two 256-bit keys from it (HKDF-SHA256):
//   encKey = AES-256-GCM key that encrypts every chunk and manifest
//   idKey  = HMAC-SHA256 key that names chunks, so chunk IDs reveal nothing about the content
//
// Sealed box layout:  [1 byte version][12 byte nonce][ciphertext][16 byte auth tag]
// Inside the ciphertext: [1 byte: 1 = compressed, 0 = not][data]

import crypto from "node:crypto";
import zlib from "node:zlib";

export const CHUNK_SIZE = 1024 * 1024; // 1 MiB
const BOX_VERSION = 1;

export function deriveKeys(myPrivateKey, theirPublicKey, deviceId) {
  const shared = crypto.diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey });
  const material = Buffer.from(
    crypto.hkdfSync("sha256", shared, Buffer.from(deviceId), Buffer.from("backup-gateway keys v1"), 64)
  );
  return { encKey: material.subarray(0, 32), idKey: material.subarray(32, 64) };
}

export function chunkId(idKey, data) {
  return crypto.createHmac("sha256", idKey).update(data).digest("hex");
}

export function seal(encKey, plaintext, aad) {
  const compressed = zlib.deflateRawSync(plaintext, { level: 6 });
  const useCompressed = compressed.length < plaintext.length;
  const inner = Buffer.concat([Buffer.from([useCompressed ? 1 : 0]), useCompressed ? compressed : plaintext]);

  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(inner), cipher.final()]);
  return Buffer.concat([Buffer.from([BOX_VERSION]), nonce, ciphertext, cipher.getAuthTag()]);
}

export function open(encKey, box, aad, maxSize = CHUNK_SIZE) {
  if (!Buffer.isBuffer(box) || box.length < 1 + 12 + 1 + 16 || box[0] !== BOX_VERSION) {
    throw new Error("Invalid sealed box");
  }
  const nonce = box.subarray(1, 13);
  const tag = box.subarray(box.length - 16);
  const ciphertext = box.subarray(13, box.length - 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  const inner = Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws if tampered

  const data = inner.subarray(1);
  if (inner[0] === 1) return zlib.inflateRawSync(data, { maxOutputLength: maxSize }); // blocks zip bombs
  if (data.length > maxSize) throw new Error("Sealed box too large");
  return data;
}