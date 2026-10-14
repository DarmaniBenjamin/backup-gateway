// Two-factor codes (src/admin/totp.js)
import test from "node:test";
import assert from "node:assert/strict";
import { base32Encode, codeAt, verifyCode, newRecoveryCodes, hashRecoveryCode, looksLikeRecoveryCode, otpauthUrl } from "../src/admin/totp.js";

const secret = base32Encode(Buffer.from("12345678901234567890")); // the RFC 6238 test secret

test("matches the RFC 6238 test codes", () => {
  assert.equal(codeAt(secret, Math.floor(59 / 30)), "287082");
  assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), "081804");
  assert.equal(codeAt(secret, Math.floor(1234567890 / 30)), "005924");
});

test("accepts the code now and one step either side, nothing further", () => {
  const now = 1234567890_000;
  const step = Math.floor(now / 30000);
  assert.equal(verifyCode(secret, codeAt(secret, step), -1, now), step);
  assert.equal(verifyCode(secret, codeAt(secret, step - 1), -1, now), step - 1);
  assert.equal(verifyCode(secret, codeAt(secret, step + 1), -1, now), step + 1);
  assert.equal(verifyCode(secret, codeAt(secret, step - 2), -1, now), null);
  assert.equal(verifyCode(secret, "12345", -1, now), null);
  assert.equal(verifyCode(secret, "abcdef", -1, now), null);
});

test("a code can't be used twice", () => {
  const now = 1234567890_000;
  const step = Math.floor(now / 30000);
  const code = codeAt(secret, step);
  const used = verifyCode(secret, code, -1, now);
  assert.equal(verifyCode(secret, code, used, now), null);
});

test("recovery codes: 10 different ones, matched however they're typed", () => {
  const codes = newRecoveryCodes();
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  assert.equal(hashRecoveryCode(codes[0]), hashRecoveryCode(codes[0].toLowerCase().replace("-", " ")));
  assert.ok(looksLikeRecoveryCode("abcd-efgh"));
  assert.ok(!looksLikeRecoveryCode("123456"));
});

test("the authenticator link has the secret and the account", () => {
  const url = otpauthUrl("ABCDEF", "dana");
  assert.match(url, /^otpauth:\/\/totp\/Backup%20Gateway%3Adana\?secret=ABCDEF&/);
});
