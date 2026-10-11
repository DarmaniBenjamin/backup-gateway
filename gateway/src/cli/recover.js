// Rebuilds a lost gateway from an off-site copy: opens the newest catalog with the recovery key,
// then gets every backed-up chunk, checking each one as it arrives. It never deletes or changes
// anything in the copy.
//
// From a Backblaze/S3 bucket (the failsafe, or one device's own bucket):
//   npm run recover -- --endpoint s3.us-west-004.backblazeb2.com --bucket my-backups \
//                      --key-id 004a1b2c3d4e5f60000000001 --to ./recovered-data
//   Optional: --region us-west-004 (worked out from B2/Wasabi/AWS endpoints), --catalog <key>.
//   The application key is asked for (or RECOVER_SECRET).
//
// From a Google Drive copy: download its "Backup Gateway - …" folder first (in Google Drive:
// right-click the folder > Download, then unzip everything into one folder), then:
//   npm run recover -- --from-folder ./Downloads/backup-gateway-drive --to ./recovered-data
//
// The recovery key is asked for (or RECOVER_KEY), so it doesn't end up in your shell history.
// A device's own copy rebuilds a gateway with just that device in it.
// Afterwards, start the gateway with GATEWAY_DATA_DIR pointing at the --to folder.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { DatabaseSync } from "node:sqlite";
import { createS3 } from "../cloud/s3.js";
import { parseRecoveryKey, openWithRecoveryKey } from "../cloud/recovery.js";
import { readCatalog, PROVIDERS } from "../cloud/offsite.js";
import { routerFor } from "../cloud/routing.js";
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
const fromFolder = a["from-folder"] ? path.resolve(String(a["from-folder"])) : null;
if (!a.to || (!fromFolder && (!a.endpoint || !a.bucket || !a["key-id"]))) {
  console.log(`Usage:
  npm run recover -- --endpoint URL --bucket NAME --key-id ID --to FOLDER [--region R] [--catalog KEY]
  npm run recover -- --from-folder DOWNLOADED-DRIVE-FOLDER --to FOLDER`);
  process.exit(1);
}
const to = path.resolve(a.to);
if (fs.existsSync(path.join(to, "gateway.db"))) fail(`${to} already has a gateway in it. Use an empty folder.`);

// ---- Where the copy is: a bucket, or a downloaded Google Drive folder ---------------------------

let source;
if (fromFolder) {
  if (!fs.statSync(fromFolder, { throwIfNoEntry: false })?.isDirectory()) fail(`${fromFolder} isn't a folder.`);
  // Every .bin file in it, wherever the download put them
  const files = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".bin")) files.set(e.name, p);
    }
  };
  // The copy's own "catalogs" and "packs" folders if they're right there (another copy made inside
  // this folder is left alone); otherwise everything, wherever the download put it
  const own = ["catalogs", "packs"].map((n) => path.join(fromFolder, n));
  if (own.every((d) => fs.statSync(d, { throwIfNoEntry: false })?.isDirectory())) own.forEach(walk);
  else walk(fromFolder);
  // One copy per run: a folder holding two copies (one made inside another) has to be narrowed down
  const catalogDirs = [...new Set([...files].filter(([n]) => n.startsWith("catalog-")).map(([, p]) => path.dirname(p)))];
  if (catalogDirs.length > 1) {
    fail(`That folder holds more than one off-site copy. Point --from-folder at just one of these:\n  ${catalogDirs.map((d) => path.dirname(d)).join("\n  ")}`);
  }
  const handles = new Map();
  source = {
    catalogs: async () => [...files.keys()].filter((n) => n.startsWith("catalog-")),
    catalog: async (name) => fs.readFileSync(files.get(name) ?? fail(`No ${name} in that folder.`)),
    // A chunk is a slice of a pack file (where exactly is in the catalog)
    chunk: async (deviceId, id, where) => {
      if (!where) throw Object.assign(new Error("not in this copy"), { code: "NotInCatalog" });
      const file = files.get(where.pack);
      if (!file) throw Object.assign(new Error(`${where.pack} is missing from the download`), { code: "MissingPack" });
      if (!handles.has(file)) handles.set(file, fs.openSync(file, "r"));
      const buf = Buffer.alloc(where.size);
      const n = fs.readSync(handles.get(file), buf, 0, where.size, where.offset);
      if (n !== where.size) throw Object.assign(new Error("pack file is cut short"), { code: "ShortPack" });
      return buf;
    },
  };
  console.log(`Found ${files.size} file(s) in ${fromFolder}`);
} else {
  let endpoint = String(a.endpoint).trim().replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`; // Backblaze shows it without https://
  const region =
    a.region ||
    Object.values(PROVIDERS).map((p) => p.regionFrom && endpoint.match(p.regionFrom)?.[1]).find(Boolean) ||
    fail("Couldn't tell the region from the endpoint. Add --region.");
  const secret = process.env.RECOVER_SECRET || (await ask("Application (secret) key for the bucket: "));
  const s3 = createS3({ endpoint, region, bucket: a.bucket, accessKeyId: a["key-id"], secretAccessKey: secret });
  source = {
    catalogs: async () => {
      const keys = [];
      let next;
      do {
        const page = await s3.list("catalog/", next).catch((err) => fail(`Can't list the bucket: ${err.message}`));
        keys.push(...page.items.map((i) => i.key).filter((k) => k.endsWith(".bin")));
        next = page.next;
      } while (next);
      return keys;
    },
    catalog: (key) => s3.getObject(key),
    chunk: (deviceId, id) => s3.getObject(`chunks/${deviceId}/${id.slice(0, 2)}/${id}`),
  };
}

let recovery;
try {
  recovery = parseRecoveryKey(process.env.RECOVER_KEY || (await ask("Recovery key (BGRK-…): ")));
} catch (err) {
  fail(err.message);
}
console.log(`Recovery key ${recovery.fingerprint}`);

// ---- 1. The newest catalog (or the one asked for) ----------------------------------------------

let catalogKey = a.catalog;
if (!catalogKey) {
  const keys = (await source.catalogs()).sort(); // names start with the time, so the last is newest
  if (!keys.length) fail(fromFolder ? "There's no catalog-….bin in that folder. Did the whole Drive folder download?" : "There's no catalog in this bucket. Is it the right bucket?");
  catalogKey = keys.at(-1);
  console.log(`Found ${keys.length} catalog(s); using the newest: ${catalogKey}`);
}
let catalog;
try {
  catalog = readCatalog(openWithRecoveryKey(recovery.privateKey, await source.catalog(catalogKey)));
} catch (err) {
  fail(err.message);
}
console.log(`Catalog from ${catalog.header.createdAt} unlocked${catalog.header.device ? " (one device's own copy)" : ""}.`);

fs.mkdirSync(to, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(to, "gateway.db"), catalog.files["gateway.db"], { mode: 0o600 });
fs.writeFileSync(path.join(to, "gateway-kx-key.pem"), catalog.files["gateway-kx-key.pem"], { mode: 0o600 });
if (catalog.files["gateway-update-key.pem"]) {
  fs.writeFileSync(path.join(to, "gateway-update-key.pem"), catalog.files["gateway-update-key.pem"], { mode: 0o600 });
}

// ---- 2. Every chunk the "ok" versions need, checked with the device's key as it arrives --------

const db = new DatabaseSync(path.join(to, "gateway.db"));
// Don't let the recovered gateway start uploading on its own: resume off-site copies in the web UI
for (const sql of ["UPDATE offsite_destinations SET paused = 1", "UPDATE cloud_config SET paused = 1"]) {
  try {
    db.exec(sql);
  } catch {
    // an older or newer catalog without that table
  }
}
const gatewayKey = crypto.createPrivateKey(catalog.files["gateway-kx-key.pem"]);
const devices = new Map(db.prepare("SELECT id, device_name, kx_public_key FROM devices").all().map((d) => [d.id, d]));
// A device's own copy only has the folders set to go to it: only look for those
let routed = () => true;
let notHere = 0;
try {
  const dest = db.prepare("SELECT id, device_id FROM offsite_destinations WHERE id = ?").get(catalog.header.destination ?? "");
  if (dest) routed = routerFor(db, dest);
} catch {
  // an older catalog: everything
}
const wanted = new Set();
for (const v of db.prepare("SELECT device_id, rel_path, chunk_ids FROM file_versions WHERE status = 'ok' AND chunk_ids IS NOT NULL").iterate()) {
  if (!routed(v.device_id, v.rel_path)) {
    notHere++;
    continue;
  }
  for (const id of JSON.parse(v.chunk_ids)) wanted.add(`${v.device_id} ${id}`);
}
if (notHere) console.log(`${notHere} file version(s) are in folders that go to a different copy, so they aren't looked for here.`);
// Google Drive: which pack file each chunk is in
const packed = new Map();
if (fromFolder) {
  const dest = catalog.header.destination;
  try {
    for (const r of db.prepare("SELECT device_id, chunk_id, pack, pack_offset, size FROM offsite_objects WHERE dest_id = ? AND pack IS NOT NULL").iterate(dest)) {
      packed.set(`${r.device_id} ${r.chunk_id}`, { pack: r.pack, offset: r.pack_offset, size: r.size });
    }
  } catch {
    fail("This catalog doesn't come from a Google Drive copy. Use --endpoint/--bucket for a bucket.");
  }
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
console.log(`Getting ${todo.length} chunk(s) for ${devices.size} device(s)…`);
let done = 0;
const missing = [];
const damaged = [];
let i = 0;
async function worker() {
  while (i < todo.length) {
    const [deviceId, id] = todo[i++];
    let box;
    try {
      box = await source.chunk(deviceId, id, packed.get(`${deviceId} ${id}`));
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
await Promise.all(Array.from({ length: fromFolder ? 1 : 8 }, worker));

console.log(`\n✔ ${done} of ${todo.length} chunk(s) recovered and verified into ${to}`);
if (missing.length) console.log(`\n${missing.length} chunk(s) weren't in the copy:\n  ${missing.slice(0, 20).join("\n  ")}`);
if (damaged.length) console.log(`\n${damaged.length} chunk(s) failed their check and were left out:\n  ${damaged.slice(0, 20).join("\n  ")}`);
console.log(`
Next:
  1. Start the gateway on this folder:  GATEWAY_DATA_DIR=${to} npm start
  2. Log in with the same admin account as before.
  3. Off-site copies are paused on the recovered gateway; resume them on the Off-site page once
     the old gateway is definitely gone.
`);
process.exit(missing.length || damaged.length ? 2 : 0);
