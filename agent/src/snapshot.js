// Open files on Windows (Outlook .pst, QuickBooks, Access and SQL databases...) are often locked by
// the program using them, so they can't be read directly. For those, the agent takes a Volume
// Shadow Copy (VSS) of the drive: a frozen, read-only picture of the whole drive at that moment,
// made by Windows itself in a second or two without disturbing the program. The locked file is
// then read from the picture, in the state it was in at that moment.
//
// One shadow copy per drive is shared by all locked files that need it in the next few minutes,
// and removed once it's no longer used. Only shadow copies this agent made are ever removed (their
// IDs are kept in snapshots.json, so ones left behind by a crash are cleaned up on the next start).
//
// Needs administrator rights (the Windows agent runs as SYSTEM). On other systems, or if Windows
// can't make a shadow copy (network drive, VSS service off), the file is skipped as before and
// tried again on the next scan.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

const REUSE_MS = 10 * 60 * 1000; // a shadow copy serves locked files for up to 10 minutes...
const IDLE_MS = 2 * 60 * 1000; // ...and is removed after 2 minutes without use
const RETRY_MS = 10 * 60 * 1000; // after a failed attempt, wait before trying that drive again
const LOCKED_CODES = new Set(["EBUSY", "EIO", "ELOCKED"]); // how Node reports a locked file on Windows
const GUID = /^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$/;
const SHADOW_DEVICE = /^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$/;

export const isLockedError = (err) => LOCKED_CODES.has(err?.code);

// Windows PowerShell by its full path (never whatever "powershell" is first on the PATH)
function powershell(script, timeoutMs = 120_000) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      // Passed encoded (UTF-16 + base64), so no quote in the script can be mangled on the way
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split("\n")[0])) : resolve(stdout.trim()))
    );
  });
}

function cmd(args) {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  return new Promise((resolve, reject) => {
    execFile(exe, ["/d", "/c", ...args], { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || stdout || err.message).trim())) : resolve()
    );
  });
}

// The real Windows calls. Replaced in tests.
export const windowsVss = {
  async create(volume) {
    const out = await powershell(
      "$ErrorActionPreference = 'Stop'\n" +
        `$r = Invoke-CimMethod -ClassName Win32_ShadowCopy -MethodName Create -Arguments @{ Volume = '${volume}'; Context = 'ClientAccessible' }\n` +
        "if ($r.ReturnValue -ne 0) { throw \"Windows couldn't make a shadow copy (code $($r.ReturnValue))\" }\n" +
        "$s = Get-CimInstance -ClassName Win32_ShadowCopy -Filter \"ID='$($r.ShadowID)'\"\n" +
        "@{ id = $r.ShadowID; device = $s.DeviceObject } | ConvertTo-Json -Compress"
    );
    return JSON.parse(out);
  },
  async remove(id) {
    await powershell(
      `Get-CimInstance -ClassName Win32_ShadowCopy -Filter "ID='${id}'" | Remove-CimInstance -ErrorAction SilentlyContinue`
    );
  },
  // A folder link to the shadow copy's root, so Node can read files from it like any folder
  async link(linkPath, device) {
    await cmd(["mklink", "/d", linkPath, `${device}\\`]);
  },
  async unlink(linkPath) {
    await cmd(["rmdir", linkPath]); // removes only the link, never what it points to
  },
};

export function createSnapshots({ dataDir, vss = windowsVss, platform = process.platform, now = () => Date.now() }) {
  const enabled = platform === "win32";
  const root = path.join(dataDir, "snapshots");
  const stateFile = path.join(dataDir, "snapshots.json");
  const byVolume = new Map(); // "C:\\" -> { id, link, createdAt, lastUsed, users, ready: Promise }
  const failed = new Map(); // "C:\\" -> { until, message }: don't retry a drive that just failed
  let timer = null;

  const saveState = () => {
    const ids = [...byVolume.values()].filter((s) => s.id).map((s) => ({ id: s.id, link: s.link }));
    try {
      fs.writeFileSync(stateFile, JSON.stringify(ids));
    } catch (err) {
      log.warn(`Could not save the shadow copy list: ${err.message}`);
    }
  };

  async function drop(snap) {
    try {
      if (snap.link) await vss.unlink(snap.link).catch(() => {});
      if (snap.id) await vss.remove(snap.id);
      log.info(`Removed the shadow copy of ${snap.volume}`);
    } catch (err) {
      log.warn(`Could not remove the shadow copy ${snap.id}: ${err.message}`);
    }
  }

  // Remove shadow copies nobody is using any more
  async function sweep() {
    for (const [volume, snap] of byVolume) {
      if (snap.users > 0 || !snap.id) continue;
      const t = now();
      if (t - snap.lastUsed >= IDLE_MS || t - snap.createdAt >= REUSE_MS) {
        byVolume.delete(volume);
        saveState();
        await drop(snap);
      }
    }
    if (byVolume.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function take(volume) {
    const snap = { volume, id: null, link: null, createdAt: now(), lastUsed: now(), users: 0 };
    snap.ready = (async () => {
      log.info(`A file on ${volume} is locked by another program: taking a shadow copy of the drive to read it`);
      const made = await vss.create(volume);
      if (!GUID.test(made?.id ?? "") || !SHADOW_DEVICE.test(made?.device ?? "")) {
        throw new Error(`unexpected answer from Windows: ${JSON.stringify(made)}`);
      }
      snap.id = made.id;
      saveState();
      fs.mkdirSync(root, { recursive: true });
      const link = path.join(root, made.id.replace(/[{}]/g, ""));
      await vss.link(link, made.device);
      snap.link = link;
      snap.createdAt = now();
      saveState();
      timer ??= setInterval(() => sweep().catch(() => {}), 30_000);
      timer.unref?.();
    })();
    byVolume.set(volume, snap);
    try {
      await snap.ready;
    } catch (err) {
      byVolume.delete(volume);
      if (snap.id) await drop(snap);
      failed.set(volume, { until: now() + RETRY_MS, message: err.message });
      log.warn(`Could not take a shadow copy of ${volume}: ${err.message}. Locked files there are tried again later.`);
      throw err;
    }
    return snap;
  }

  return {
    enabled,

    // Clean up shadow copies a previous run made but couldn't remove (crash, power cut)
    async cleanupLeftovers() {
      if (!enabled) return;
      let old = [];
      try {
        old = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      } catch {
        // no list: still clear any stale links below
      }
      for (const s of Array.isArray(old) ? old : []) {
        if (!GUID.test(s?.id ?? "")) continue;
        await drop({ volume: "a drive", id: s.id, link: typeof s.link === "string" && s.link.startsWith(root) ? s.link : null });
      }
      // Links to shadow copies that are gone
      try {
        for (const name of fs.readdirSync(root)) await vss.unlink(path.join(root, name)).catch(() => {});
      } catch {
        // no folder: nothing to clean
      }
      try {
        fs.writeFileSync(stateFile, "[]");
      } catch {
        // nothing to clean next time either way
      }
    },

    // Runs fn(readablePath) with a path to read the file from a shadow copy of its drive.
    // The shadow copy is kept until fn is done.
    async withSnapshotPath(absPath, fn) {
      if (!enabled) throw new Error("shadow copies are only available on Windows");
      const parsed = path.win32.parse(path.win32.resolve(absPath));
      const volume = parsed.root.toUpperCase();
      if (!/^[A-Z]:\\$/.test(volume)) throw new Error(`no shadow copies for ${parsed.root} (only local drives)`);
      const fail = failed.get(volume);
      if (fail && now() < fail.until) throw new Error(`no shadow copy of ${volume} right now (${fail.message})`);

      let snap = byVolume.get(volume);
      if (snap) {
        await snap.ready.catch(() => {});
        if (!byVolume.has(volume) || (snap.id && now() - snap.createdAt >= REUSE_MS && snap.users === 0)) {
          if (byVolume.get(volume) === snap) {
            byVolume.delete(volume);
            saveState();
            await drop(snap);
          }
          snap = null;
        }
      }
      snap = snap ?? byVolume.get(volume) ?? (await take(volume));
      await snap.ready;
      snap.users++;
      try {
        const inside = path.win32.join(snap.link, path.win32.relative(volume, path.win32.resolve(absPath)));
        return await fn(inside);
      } finally {
        snap.users--;
        snap.lastUsed = now();
      }
    },

    // Remove every shadow copy right away (the agent is stopping)
    async closeAll() {
      if (timer) clearInterval(timer);
      timer = null;
      const all = [...byVolume.values()];
      byVolume.clear();
      for (const snap of all) {
        await snap.ready?.catch(() => {});
        if (snap.id) await drop(snap);
      }
      if (enabled) saveState();
    },

    sweep, // for tests
  };
}
