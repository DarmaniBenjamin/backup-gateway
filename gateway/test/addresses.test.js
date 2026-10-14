// The addresses install links use (src/installs.js)
import test from "node:test";
import assert from "node:assert/strict";
import { agentApiChoices, agentApiUrl } from "../src/installs.js";

const config = { host: "0.0.0.0", port: 8080, publicUrl: "https://backup.acme.io" };
const req = (host) => ({ headers: { host } });

test("the domain comes first once it works", () => {
  assert.equal(agentApiChoices(config)[0].url, "https://backup.acme.io");
  assert.equal(agentApiChoices(config)[0].kind, "domain");
});

test("a device gets the address it used, if it's one of the gateway's", () => {
  assert.equal(agentApiUrl(config, req("backup.acme.io")).url, "https://backup.acme.io");
  assert.equal(agentApiUrl(config, req("backup.acme.io:443")).url, "https://backup.acme.io");
});

test("a made-up Host header can't point an install somewhere else", () => {
  assert.equal(agentApiUrl(config, req("evil.example")).url, "https://backup.acme.io");
  assert.equal(agentApiUrl(config, req("backup.acme.io.evil.example")).url, "https://backup.acme.io");
});

test("only this computer: 127.0.0.1", () => {
  const local = agentApiChoices({ host: "127.0.0.1", port: 8080, publicUrl: null });
  assert.deepEqual(local.map((c) => c.kind), ["local"]);
});
