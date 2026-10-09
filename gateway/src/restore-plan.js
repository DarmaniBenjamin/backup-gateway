// Works out exactly which file versions a restore should bring back, and creates restore jobs.
//
//   path    = one file, a folder, or "" for everything
//   version = a specific version number (only for a single file)
//   at      = a point in time: "give me everything as it was at this moment"
//             (this is the ransomware case: restore the folder as it was before the attack)
// Files whose chosen version is "deleted" are skipped — they didn't exist at that time.
// Used by both the command line (npm run restore) and the web UI.

export class RestoreError extends Error {}

export function normalizePath(p) {
  return String(p ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

export function buildRestorePlan(db, { sourceDeviceId, path = "", version = null, at = null }) {
  const relPath = normalizePath(path);
  const rows = db.versionsUnder(sourceDeviceId, relPath);

  if (version != null) {
    const match = rows.find((r) => r.rel_path === relPath && r.version_no === version);
    if (!match) throw new RestoreError(`No version ${version} of "${relPath}" found`);
    if (match.type === "deleted") throw new RestoreError(`Version ${version} of "${relPath}" is a deletion record`);
    return [toPlanFile(match)];
  }

  const latest = new Map(); // rel_path -> newest version at or before `at`
  for (const row of rows) {
    if (at && new Date(row.received_at) > at) continue;
    latest.set(row.rel_path, row); // rows are sorted by version, so the last one wins
  }

  return [...latest.values()].filter((r) => r.type !== "deleted").map(toPlanFile);
}

function toPlanFile(row) {
  return {
    relPath: row.rel_path,
    versionNo: row.version_no,
    size: row.size,
    sha256: row.sha256,
    chunkIds: JSON.parse(row.chunk_ids),
    backedUpAt: row.received_at,
  };
}

// Checks every option and builds the plan. With create = true it also queues the job.
export function prepareRestore(db, { device, to, path, version, at, mode = "copy" }, { create = false } = {}) {
  const findDevice = (nameOrId, label) => {
    const matches = db.listDevices().filter((d) => d.id === nameOrId || d.device_name === nameOrId);
    if (matches.length === 0) throw new RestoreError(`No ${label} device called "${nameOrId}".`);
    if (matches.length > 1) throw new RestoreError(`Several devices are called "${nameOrId}" — use the device ID.`);
    if (matches[0].status !== "active") throw new RestoreError(`Device "${nameOrId}" is ${matches[0].status}.`);
    return matches[0];
  };

  if (!device) throw new RestoreError("A source device is required.");
  if (!["copy", "overwrite"].includes(mode)) throw new RestoreError('Mode must be "copy" or "overwrite".');

  const source = findDevice(device, "source");
  const target = to ? findDevice(to, "target") : source;
  if (!target.kx_public_key) {
    throw new RestoreError(`Device "${target.device_name}" hasn't finished its key exchange — start its agent first.`);
  }

  const versionNo = version != null && version !== "" ? Number(version) : null;
  if (versionNo != null && (!Number.isInteger(versionNo) || versionNo < 1)) {
    throw new RestoreError("Version must be a whole number like 1 or 2.");
  }
  if (versionNo != null && at) throw new RestoreError("Use either a version or a point in time, not both.");

  let atDate = null;
  if (at) {
    atDate = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(atDate.getTime())) throw new RestoreError(`Couldn't understand the date "${at}".`);
  }

  const relPath = normalizePath(path);
  const files = buildRestorePlan(db, { sourceDeviceId: source.id, path: relPath, version: versionNo, at: atDate });
  if (files.length === 0) throw new RestoreError("Nothing to restore — no backed-up files match.");

  const label = [
    relPath ? `"${relPath}"` : "all files",
    versionNo ? `version ${versionNo}` : atDate ? `as of ${atDate.toLocaleString()}` : "latest versions",
    `from ${source.device_name}`,
  ].join(", ");

  const plan = {
    label,
    mode,
    source: { id: source.id, name: source.device_name, client: source.client_name },
    target: { id: target.id, name: target.device_name, client: target.client_name },
    fileCount: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    files,
  };

  if (create) {
    plan.jobId = db.addCommand(target.id, "restore", { sourceDeviceId: source.id, mode, label, files });
  }
  return plan;
}