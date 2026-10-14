// The addresses the agent accepts from the gateway's list (src/connection.js)
import test from "node:test";
import assert from "node:assert/strict";
import { cleanUrl } from "../src/connection.js";

test("keeps http and https addresses, without any path", () => {
  assert.equal(cleanUrl("https://backup.acme.io/"), "https://backup.acme.io");
  assert.equal(cleanUrl("http://192.0.2.2:8080/api/x"), "http://192.0.2.2:8080");
});

test("refuses anything else", () => {
  for (const bad of ["ftp://x.io", "javascript:alert(1)", "file:///etc/passwd", "https://user:pw@x.io", "not a url", null]) {
    assert.equal(cleanUrl(bad), null, String(bad));
  }
});
