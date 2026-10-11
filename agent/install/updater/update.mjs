// The agent's updater. It runs as root (Linux, Synology) or SYSTEM (Windows), separately from the
// agent, started when the agent asks for an update (<data>/update/request.json):
//   Linux/Synology: backup-agent-update.path starts backup-agent-update.service
//   Windows:        the agent runs the on-demand task "BackupAgentUpdate"
//
//   node update.mjs <updater.json>
//
// updater.json (written by the installer, root/SYSTEM only):
//   { "prefix": "/opt/backup-agent", "dataDir": "...", "platform": "linux|synology|windows",
//     "service": "backup-agent", "node": "/opt/backup-agent/node/bin/node" }
// update-key.pem next to it: the gateway's update key, given to the installer by the gateway.
//
// What it does:
//   1. reads the package, manifest and signature the agent left, and checks them: the signature
//      must be the gateway's update key's, the package must match the manifest, and the version
//      must be newer than the installed one (no downgrades)
//   2. unpacks the new version beside the current one (app.new), with its packages
//   3. stops the agent, swaps app.new in (the old version stays as app.old), starts the agent
//   4. waits for the new agent to report in (alive.json). If it doesn't within two minutes, it
//      puts the old version back and starts that
//   5. writes result.json for the agent to report to the gateway
// Nothing in the agent's own folder is trusted without these checks: on Linux, the agent's
// account can write there, but it can't make the gateway's signature.
//
// It also uninstalls the agent when the web UI asks: request.json with action "uninstall" and an
// order the gateway signed with the same key, naming this device (from identity.json) and less
// than a day old. It removes the service, program, identity, keys and settings, and itself. The
// files that were backed up on this device are never touched.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const WAIT_ALIVE_MS = Number(process.env.UPDATER_WAIT_MS || 120_000);
const confPath = process.argv[2] || path.join(path.dirname(new URL(import.meta.url).pathname), "updater.json");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
const here = path.dirname(confPath);
const updDir = path.join(conf.dataDir, "update");
const app = path.join(conf.prefix, "app");
const appNew = path.join(conf.prefix, "app.new");
const appOld = path.join(conf.prefix, "app.old");
const win = conf.platform === "windows";
const logFile = path.join(here, "update.log");

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(logFile, `${line}\n`);
  } catch {
    // the log is a convenience
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
function newerVersion(a, b) {
  const p = (v) => String(v ?? "0").split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : 0));
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

// Results go where the agent can read them (and owned by the agent's account on Linux)
// (removed first and created fresh, never followed through a link the agent's account put there)
function writeResult(result) {
  const file = path.join(updDir, "result.json");
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify({ ...result, at: new Date().toISOString() }), { flag: "wx", mode: 0o644 });
  if (!win) {
    const { uid, gid } = fs.statSync(updDir);
    fs.chownSync(file, uid, gid);
  }
}
function cleanup() {
  for (const name of fs.readdirSync(updDir)) {
    if (name === "request.json" || name.startsWith("package.") || name.startsWith("manifest.")) fs.rmSync(path.join(updDir, name), { force: true });
  }
}

// ---- The agent's service ---------------------------------------------------------------------

function run(cmd, args, { ignore = false } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", windowsHide: true });
  if (r.status !== 0 && !ignore) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return r;
}
async function stopAgent() {
  if (!win) {
    run("systemctl", ["stop", conf.service]);
    return;
  }
  run("schtasks.exe", ["/end", "/tn", conf.service], { ignore: true });
  // The task can leave node.exe running a moment; stop the agent's own process (from alive.json)
  const pid = readJson(path.join(updDir, "alive.json"))?.pid;
  if (pid && pid !== process.pid) {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
  await sleep(2000);
}
function startAgent() {
  if (!win) run("systemctl", ["start", conf.service]);
  else run("schtasks.exe", ["/run", "/tn", conf.service]);
}

// ---- Unpacking (the gateway's own simple .tar.gz / .zip) -------------------------------------

function safeRel(name) {
  if (!name.startsWith("agent/")) return null;
  const rel = name.slice("agent/".length);
  if (!rel || rel.includes("\\") || rel.split("/").some((p) => p === ".." || p === "" || p === ".")) return null;
  return rel;
}
function* tarEntries(buf) {
  let at = 0;
  while (at + 512 <= buf.length) {
    const h = buf.subarray(at, at + 512);
    if (h.every((b) => b === 0)) return;
    const name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = parseInt(h.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === "0") yield { name, data };
  }
}
function* zipEntries(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("damaged zip directory");
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    at += 46 + nameLen + extraLen + commentLen;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + packed);
    if (name.endsWith("/")) continue;
    yield { name, data: method === 8 ? zlib.inflateRawSync(raw) : raw };
  }
}

function unpack(pkg, kind, into) {
  fs.rmSync(into, { recursive: true, force: true });
  fs.mkdirSync(into, { recursive: true });
  let n = 0;
  const entries = kind === "zip" ? zipEntries(pkg) : tarEntries(zlib.gunzipSync(pkg));
  for (const { name, data } of entries) {
    const rel = safeRel(name);
    if (!rel) continue;
    const out = path.join(into, ...rel.split("/"));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, data, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
    n++;
  }
  return n;
}

// ---- Uninstalling ----------------------------------------------------------------------------

function checkOrder(request) {
  const key = crypto.createPublicKey(fs.readFileSync(path.join(here, "update-key.pem")));
  const text = String(request.order ?? "");
  if (!crypto.verify(null, Buffer.from(text), key, Buffer.from(String(request.signature ?? ""), "base64"))) {
    throw new Error("the uninstall order isn't signed by this gateway's update key");
  }
  const order = JSON.parse(text);
  if (order.format !== "backup-agent-uninstall") throw new Error("not an uninstall order");
  const identity = readJson(path.join(conf.dataDir, "identity.json"));
  if (!identity?.deviceId || identity.deviceId !== order.deviceId) throw new Error("the uninstall order is for another device");
  if (!(Math.abs(Date.now() - Date.parse(order.issuedAt)) < 24 * 3600_000)) throw new Error("the uninstall order is too old");
  return order;
}

function uninstallUnix() {
  const svc = conf.service;
  const linux = conf.platform === "linux";
  // Only ever the folders the installers use
  if (!/^[\w.-]+$/.test(svc)) throw new Error(`unexpected service name ${svc}`);
  if (linux && (conf.prefix !== "/opt/backup-agent" || conf.dataDir !== "/var/lib/backup-agent")) throw new Error("unexpected install folders");
  if (!linux && (!/^\/volume\d+\/@backup-agent$/.test(conf.prefix) || conf.dataDir !== `${conf.prefix}/data`)) throw new Error("unexpected install folders");
  const units = [`${svc}.service`, `${svc}-update.service`, `${svc}-update.path`].map((u) => `/etc/systemd/system/${u}`);
  run("systemctl", ["disable", "--now", `${svc}-update.path`], { ignore: true }); // this updater keeps running
  run("systemctl", ["disable", "--now", svc], { ignore: true });
  for (const f of [...units, ...(linux ? ["/etc/sysctl.d/90-backup-agent.conf"] : [])]) fs.rmSync(f, { force: true });
  run("systemctl", ["daemon-reload"], { ignore: true });
  if (linux) {
    fs.rmSync(conf.dataDir, { recursive: true, force: true });
    fs.rmSync("/etc/backup-agent", { recursive: true, force: true });
    run("userdel", ["backup-agent"], { ignore: true });
  }
  fs.rmSync(conf.prefix, { recursive: true, force: true });
}

// Windows: the agent's tasks and folders are removed by a one-off SYSTEM task a few seconds
// after this updater exits (its own node.exe is in the folder being removed)
async function uninstallWindows() {
  if (!/\\BackupAgent$/i.test(conf.prefix) || !/\\BackupAgent\\data$/i.test(conf.dataDir)) throw new Error("unexpected install folders");
  if (!/^[\w.-]+$/.test(conf.service)) throw new Error(`unexpected task name ${conf.service}`);
  const ps = (v) => `'${String(v).replace(/'/g, "''")}'`;
  await stopAgent();
  const script = path.join(here, "cleanup.ps1");
  fs.writeFileSync(script, [
    "# Removes the backup agent (written by its updater, as asked from the gateway's web UI)",
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Start-Sleep -Seconds 5",
    `foreach ($t in @(${ps(conf.service)}, ${ps(`${conf.service}Update`)})) { Stop-ScheduledTask -TaskName $t; Unregister-ScheduledTask -TaskName $t -Confirm:$false }`,
    `$prefix = ${ps(conf.prefix)}`,
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ExecutablePath -like \"$prefix\\*\" } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }",
    "Start-Sleep -Seconds 2",
    "Remove-Item -LiteralPath $prefix -Recurse -Force",
    `Remove-Item -LiteralPath ${ps(path.dirname(conf.dataDir))} -Recurse -Force`,
    "Unregister-ScheduledTask -TaskName 'BackupAgentCleanup' -Confirm:$false",
    "",
  ].join("\r\n"));
  const register = [
    `$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + ${ps(script)} + '"')`,
    "$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest",
    "Register-ScheduledTask -TaskName 'BackupAgentCleanup' -Action $a -Principal $p -Force | Out-Null",
    "Start-ScheduledTask -TaskName 'BackupAgentCleanup'",
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(register, "utf16le").toString("base64")]);
}

async function uninstall(request) {
  let order = null;
  try {
    order = checkOrder(request);
    log(`Uninstalling the agent, as asked by ${order.by ?? "the gateway"} (order signature checked)`);
    if (win) await uninstallWindows();
    else uninstallUnix();
    console.log("The backup agent was uninstalled.");
  } catch (err) {
    log(`Uninstall failed: ${err.message}`);
    try {
      writeResult({ ok: false, action: "uninstall", order: order?.id ?? null, error: err.message });
      fs.rmSync(path.join(updDir, "request.json"), { force: true });
    } catch {
      // nothing more to do
    }
  }
}

// ---- Main ------------------------------------------------------------------------------------

async function main() {
  // The update folder must be a real folder, not a link somewhere else
  const st = fs.lstatSync(updDir, { throwIfNoEntry: false });
  if (!st || !st.isDirectory() || st.isSymbolicLink()) return;
  const reqPath = path.join(updDir, "request.json");
  const request = readJson(reqPath);
  if (!request) return; // nothing to do (the path unit can fire twice)
  if (request.action === "uninstall") return uninstall(request);

  // One update at a time
  const lock = path.join(here, "update.lock");
  try {
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > 30 * 60_000) fs.rmSync(lock, { force: true });
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    log("Another update is running; leaving this one to it.");
    return;
  }

  const current = readJson(path.join(app, "package.json"))?.version;
  let manifest = null;
  let swapped = false;
  try {
    // 1. Read everything once, then check it (what was checked is what gets installed)
    const manifestText = fs.readFileSync(path.join(updDir, "manifest.json"), "utf8");
    const signature = Buffer.from(fs.readFileSync(path.join(updDir, "manifest.sig"), "utf8").trim(), "base64");
    const key = crypto.createPublicKey(fs.readFileSync(path.join(here, "update-key.pem")));
    if (!crypto.verify(null, Buffer.from(manifestText), key, signature)) throw new Error("the update isn't signed by this gateway's update key");
    manifest = JSON.parse(manifestText);
    if (manifest.format !== "backup-agent-update") throw new Error("not an agent update");
    if (manifest.version !== request.version) throw new Error("the request and the signed manifest name different versions");
    if (!newerVersion(manifest.version, current)) throw new Error(`${manifest.version} isn't newer than the installed ${current}`);
    const kind = win ? "zip" : "tar";
    const pkg = fs.readFileSync(path.join(updDir, win ? "package.zip" : "package.tar.gz"));
    const sha = crypto.createHash("sha256").update(pkg).digest("hex");
    if (pkg.length !== manifest[kind].size || sha !== manifest[kind].sha256) throw new Error("the package doesn't match its signed manifest");
    log(`Installing agent ${manifest.version} (now ${current}); signature and SHA-256 checked`);

    // 2. Unpack beside the running version, with its packages
    const stage = path.join(conf.prefix, "update-stage");
    unpack(pkg, kind, stage);
    const staged = readJson(path.join(stage, "package.json"));
    if (staged?.version !== manifest.version) throw new Error("the package holds a different version than its manifest says");
    fs.rmSync(appNew, { recursive: true, force: true });
    fs.mkdirSync(appNew, { recursive: true });
    fs.cpSync(path.join(stage, "src"), path.join(appNew, "src"), { recursive: true });
    for (const f of ["package.json", "package-lock.json"]) fs.copyFileSync(path.join(stage, f), path.join(appNew, f));
    // Synology keeps its installer inside app/ (to repair the service after a DSM update)
    if (fs.existsSync(path.join(app, "install"))) fs.cpSync(path.join(stage, "install"), path.join(appNew, "install"), { recursive: true });
    // The same packages as now (only the agent's own version number differs): reuse them
    const deps = (file) => {
      const lock = readJson(file);
      if (!lock) return null;
      delete lock.version;
      if (lock.packages?.[""]) delete lock.packages[""].version;
      return JSON.stringify(lock);
    };
    const sameLock = fs.existsSync(path.join(app, "node_modules")) && deps(path.join(stage, "package-lock.json")) === deps(path.join(app, "package-lock.json"));
    if (sameLock) {
      fs.cpSync(path.join(app, "node_modules"), path.join(appNew, "node_modules"), { recursive: true });
    } else {
      log("Its packages changed: installing them");
      const nodeDir = path.dirname(conf.node);
      const npm = win ? path.join(nodeDir, "npm.cmd") : path.join(nodeDir, "npm");
      const r = spawnSync(npm, ["ci", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], {
        cwd: appNew, encoding: "utf8", shell: win, windowsHide: true,
        env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH ?? ""}`, HOME: conf.prefix, npm_config_cache: path.join(conf.prefix, ".npm") },
      });
      fs.rmSync(path.join(conf.prefix, ".npm"), { recursive: true, force: true });
      if (r.status !== 0) throw new Error(`installing its packages failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
    }

    // 3. Swap and start
    await stopAgent();
    fs.rmSync(appOld, { recursive: true, force: true });
    fs.renameSync(app, appOld);
    fs.renameSync(appNew, app);
    swapped = true;
    const swappedAt = new Date().toISOString();
    startAgent();
    log("New version started; waiting for it to connect to the gateway");

    // 4. Did it come up?
    const deadline = Date.now() + WAIT_ALIVE_MS;
    let alive = null;
    while (Date.now() < deadline) {
      await sleep(2000);
      const a = readJson(path.join(updDir, "alive.json"));
      if (a?.version === manifest.version && a.at > swappedAt) {
        alive = a;
        break;
      }
    }
    if (!alive) throw new Error(`agent ${manifest.version} didn't connect to the gateway within ${Math.round(WAIT_ALIVE_MS / 1000)}s`);

    // 5. Done: keep the new updater too, and tidy up
    fs.rmSync(appOld, { recursive: true, force: true });
    const nextUpdater = path.join(stage, "install", "updater", "update.mjs");
    if (fs.existsSync(nextUpdater)) fs.copyFileSync(nextUpdater, path.join(here, "update.mjs"));
    fs.rmSync(stage, { recursive: true, force: true });
    writeResult({ ok: true, version: manifest.version, from: current });
    log(`Agent ${manifest.version} is running`);
  } catch (err) {
    log(`Update failed: ${err.message}`);
    let rolledBack = false;
    if (swapped && fs.existsSync(appOld)) {
      try {
        await stopAgent();
        fs.rmSync(app, { recursive: true, force: true });
        fs.renameSync(appOld, app);
        startAgent();
        rolledBack = true;
        log(`Put back agent ${current}`);
      } catch (e) {
        log(`Couldn't put the old version back: ${e.message}`);
      }
    } else {
      fs.rmSync(appNew, { recursive: true, force: true });
    }
    fs.rmSync(path.join(conf.prefix, "update-stage"), { recursive: true, force: true });
    writeResult({ ok: false, version: manifest?.version ?? request.version, from: current, error: `${err.message}${rolledBack ? `; kept ${current}` : ""}`, rolledBack });
  } finally {
    cleanup();
    fs.rmSync(lock, { force: true });
  }
}

main().catch((err) => {
  log(`Updater error: ${err.stack || err.message}`);
  process.exitCode = 1;
});
