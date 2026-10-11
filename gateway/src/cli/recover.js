// Rebuilds a lost gateway from the off-site copy: downloads the newest catalog, unlocks it with
// the recovery key, and downloads every backed-up chunk, checking each one as it arrives.
// It never deletes or changes anything in the bucket (a read-only key is enough).
//
// Usage (the two secrets are asked for, so they don't end up in your shell history):
//   npm run recover -- --endpoint https://s3.us-west-004.backblazeb2.com --bucket my-backups \
//                      --key-id 004a1b2c3d4e5f60000000001 --to ./recovered-data
// Optional: --region us-west-004 (worked out from B2/Wasabi/AWS endpoints), --catalog <key> to use
// an older catalog. The secrets can also come from RECOVER_SECRET and RECOVER_KEY.
//
// Afterwards, start the gateway with GATEWAY_DATA_DIR pointing at the --to folder.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { createS3 } from "../cloud/s3.js";
import { parseRecoveryKey, openWithRecoveryKey } from "../cloud/recovery.js";
import { readCatalog, PROVIDERS } from "../cloud/offsite.js";
import { deriveKeys, chunkId, open } from "../crypto-box.js";

function args() {
  const out = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith("--")) out[list[i].slice(2)] = list[i + 1]?.startsWith("--") ? true : list[++i];
  }
  return out;
}

function fail(message) {
  console.error(`\n✘ ${message}\n`);
  process.exit(1);
}

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

const a = args();
if (!a.endpoint || !a.bucket || !a["key-id"] || !a.to) {
  console.log(`Usage: npm run recover -- --endpoint URL --bucket NAME --key-id ID --to FOLDER [--region R] [--catalog KEY]`);
  process.exit(1);
}
const endpoint = a.endpoint.replace(/\/+$/, "");
const region =
  a.region ||
  Object.values(PROVIDERS).map((p) => p.regionFrom && endpoint.match(p.regionFrom)?.[1]).find(Boolean) ||
  fail("Couldn't tell the region from the endpoint. Add --region.");
const to = path.resolve(a.to);
if (fs.existsSync(path.join(to, "gateway.db"))) fail(`${to} already has a gateway in it. Use an empty folder.`);

const secret = process.env.RECOVER_SECRET || (await ask("Application (secret) key for the bucket: "));
let recovery;
try {
  recovery = parseRecoveryKey(process.env.RECOVER_KEY || (await ask("Recovery key (BGRK-…): ")));
} catch (err) {
  fail(err.message);
}
console.log(`Recovery key ${recovery.fingerprint}`);

const s3 = createS3({ endpoint, region, bucket: a.bucket, accessKeyId: a["key-id"], secretAccessKey: secret });

// 1. The newest catalog (or the one asked for)
let catalogKey = a.catalog;
if (!catalogKey) {
  const keys = [];
  let next;
  do {
    const page = await s3.list("catalog/", next).catch((err) => fail(`Can't list the bucket: ${err.message}`));
    keys.push(...page.items.map((i) => i.key).filter((k) => k.endsWith(".bin")));
    next = page.next;
  } while (next);
  if (!keys.length) fail("There's no catalog in this bucket. Is it the right bucket?");
  keys.sort();
  catalogKey = keys.at(-1);
  console.log(`Found ${keys.length} catalog(s); using the newest: ${catalogKey}`);
}
let catalog;
try {
  catalog = readCatalog(openWithRecoveryKey(recovery.privateKey, await s3.getObject(catalogKey)));
} catch (err) {
  fail(err.message);
}
console.log(`Catalog from ${catalog.header.createdAt} unlocked.`);

fs.mkdirSync(to, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(to, "gateway.db"), catalog.files["gateway.db"], { mode: 0o600 });
fs.writeFileSync(path.join(to, "gateway-kx-key.pem"), catalog.files["gateway-kx-key.pem"], { mode: 0o600 });

// 2. Every chunk the "ok" versions need, checked with the device's key as it arrives
const db = new DatabaseSync(path.join(to, "gateway.db"));
// Don't let the recovered gateway start uploading on its own: you resume off-site in the web UI
try {
  db.exec("UPDATE cloud_config SET paused = 1");
} catch {
  // older catalog without off-site settings
}
const gatewayKey = crypto.createPrivateKey(catalog.files["gateway-kx-key.pem"]);
const devices = new Map(db.prepare("SELECT id, device_name, kx_public_key FROM devices").all().map((d) => [d.id, d]));
const wanted = new Set();
for (const v of db.prepare("SELECT device_id, chunk_ids FROM file_versions WHERE status = 'ok' AND chunk_ids IS NOT NULL").iterate()) {
  for (const id of JSON.parse(v.chunk_ids)) wanted.add(`${v.device_id} ${id}`);
}
db.close();

const keyCache = new Map();
function keysFor(deviceId) {
  if (!keyCache.has(deviceId)) {
    const d = devices.get(deviceId);
    keyCache.set(deviceId, d?.kx_public_key ? deriveKeys(gatewayKey, crypto.createPublicKey(d.kx_public_key), deviceId) : null);
  }
  return keyCache.get(deviceId);
}

const todo = [...wanted].map((k) => k.split(" "));
console.log(`Downloading ${todo.length} chunk(s) for ${devices.size} device(s)…`);
let done = 0;
const missing = [];
const damaged = [];
let i = 0;
async function worker() {
  while (i < todo.length) {
    const [deviceId, id] = todo[i++];
    let box;
    try {
      box = await s3.getObject(`chunks/${deviceId}/${id.slice(0, 2)}/${id}`);
    } catch (err) {
      missing.push(`${devices.get(deviceId)?.device_name ?? deviceId}: ${id.slice(0, 12)}… (${err.code || err.message})`);
      continue;
    }
    const k = keysFor(deviceId);
    try {
      if (!k || chunkId(k.idKey, open(k.encKey, box, `chunk:${id}`)) !== id) throw new Error("mismatch");
    } catch {
      damaged.push(`${devices.get(deviceId)?.device_name ?? deviceId}: ${id.slice(0, 12)}…`);
      continue;
    }
    const file = path.join(to, "devices", deviceId, "chunks", id.slice(0, 2), id);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, box, { mode: 0o600 });
    if (++done % 200 === 0) console.log(`  ${done} / ${todo.length}`);
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

console.log(`\n✔ ${done} of ${todo.length} chunk(s) recovered and verified into ${to}`);
if (missing.length) console.log(`\n${missing.length} chunk(s) weren't in the bucket:\n  ${missing.slice(0, 20).join("\n  ")}`);
if (damaged.length) console.log(`\n${damaged.length} chunk(s) failed their check and were left out:\n  ${damaged.slice(0, 20).join("\n  ")}`);
console.log(`
Next:
  1. Start the gateway on this folder:  GATEWAY_DATA_DIR=${to} npm start
  2. Log in with the same admin account as before.
  3. Off-site copying is paused on the recovered gateway; resume it on the Off-site page once
     the old gateway is definitely gone.
`);
process.exit(missing.length || damaged.length ? 2 : 0);
