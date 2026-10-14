// Several failsafe copies at once (src/cloud/copies.js): each gets everything, the same bucket can't
// be added twice, and reconnecting a bucket keeps what's already uploaded there
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.js";
import { createCopies, CopyError } from "../src/cloud/copies.js";
import { routerFor } from "../src/cloud/routing.js";

const bucket = (name, endpoint = "https://s3.us-west-004.backblazeb2.com") => ({
  provider: "b2", endpoint, region: "us-west-004", bucket: name, keyId: "k", secret: "s", lockMode: "COMPLIANCE", retentionDays: 30,
});

function setup() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bg-copies-"));
  const db = openDatabase(dataDir);
  const copies = createCopies({ db, dataDir, storage: {} });
  const conn = new DatabaseSync(path.join(dataDir, "gateway.db"));
  return { copies, conn, cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("two failsafes at once, both listed, the first one stays 'the' failsafe", (t) => {
  const s = setup();
  t.after(s.cleanup);
  const a = s.copies.addS3(bucket("backups-a"), null, "dana");
  const b = s.copies.addS3(bucket("backups-b", "https://s3.wasabisys.com"), null, "dana");
  assert.equal(a.id, "failsafe");
  assert.match(b.id, /^f[0-9a-f]{12}$/);
  assert.deepEqual(s.copies.failsafes().map((c) => c.id), [a.id, b.id]);
  assert.equal(s.copies.failsafe().id, "failsafe");
  assert.ok(s.copies.failsafes().every((c) => c.failsafe));
  assert.ok(a.recoveryKey, "the recovery key is shown with the first copy");
  assert.equal(b.recoveryKey, null, "...and not again: one key opens every copy");
});

test("each failsafe gets everything from every device", (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.copies.addS3(bucket("backups-a"), null, "dana");
  s.copies.addS3(bucket("backups-b"), null, "dana");
  for (const c of s.copies.failsafes()) {
    const goes = routerFor(s.conn, s.copies.raw(c.id));
    assert.equal(goes({ device_id: "dev_1", rel_path: "Docs/a.txt" }), true);
    assert.equal(goes({ device_id: "dev_2", rel_path: "Photos/b.jpg" }), true);
  }
});

test("the same bucket can't be a failsafe twice", (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.copies.addS3(bucket("backups-a"), null, "dana");
  assert.throws(() => s.copies.addS3(bucket("backups-a"), null, "dana"), CopyError);
});

test("reconnecting a failsafe's bucket keeps its id and what's already uploaded", (t) => {
  const s = setup();
  t.after(s.cleanup);
  s.copies.addS3(bucket("backups-a"), null, "dana");
  const b = s.copies.addS3(bucket("backups-b"), null, "dana");
  s.conn.prepare("INSERT INTO offsite_objects (dest_id, device_id, chunk_id, size, uploaded_at) VALUES (?, 'dev_1', 'c1', 10, ?)").run(b.id, new Date().toISOString());
  s.copies.disconnect(b.id);
  assert.equal(s.copies.failsafes().length, 1);
  const again = s.copies.addS3(bucket("backups-b"), null, "dana");
  assert.equal(again.id, b.id);
  assert.equal(s.conn.prepare("SELECT COUNT(*) AS n FROM offsite_objects WHERE dest_id = ?").get(b.id).n, 1);
  // A different bucket is a new copy, starting from nothing
  const c = s.copies.addS3(bucket("backups-c"), null, "dana");
  assert.notEqual(c.id, b.id);
  assert.equal(s.conn.prepare("SELECT COUNT(*) AS n FROM offsite_objects WHERE dest_id = ?").get(c.id).n, 0);
});
