// Antivirus scanning with ClamAV (free, open source). Every new file version is streamed to the
// ClamAV daemon (clamd) while the gateway rebuilds and checks it, so the decrypted file never
// touches the disk. A detection quarantines the version, like the ransomware checks do.
//
// clamd is found by itself at its usual address (Arch, Debian/Ubuntu, Fedora), or set
// GATEWAY_CLAMAV to a socket path (/run/clamav/clamd.ctl) or host:port (127.0.0.1:3310).
// GATEWAY_CLAMAV=off turns scanning off.
//
// Scan results per version (file_versions.scan_status):
//   clean      scanned, nothing found
//   infected   ClamAV recognised it (scan_signature says what); the version is quarantined
//   too-big    bigger than clamd's StreamMaxLength, so not scanned (raise it in clamd.conf)
//   pending    ClamAV was down when it arrived: scanned again as soon as it's back; off-site
//              copies wait for that
//   off        no ClamAV on this gateway

import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import { log } from "./logger.js";

const KNOWN_SOCKETS = ["/run/clamav/clamd.ctl", "/var/run/clamav/clamd.ctl", "/run/clamd.scan/clamd.sock", "/var/run/clamd.scan/clamd.sock"];
const PIECE = 64 * 1024; // clamd INSTREAM pieces
const TIMEOUT_MS = 120_000;

export function parseClamAddress(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  if (/^(off|no|false|0)$/i.test(v)) return { off: true };
  const tcp = v.match(/^(?:tcp:\/\/)?([\w.-]+|\[[\da-f:]+\]):(\d{1,5})$/i);
  if (tcp) return { host: tcp[1].replace(/^\[|\]$/g, ""), port: Number(tcp[2]) };
  return { path: v.replace(/^unix:\/?\/?/, "/").replace(/^\/\//, "/") };
}

// "ClamAV 1.4.1/27420/Sat Oct 10 08:22:31 2026" -> { engine, signatures, signaturesDate }
export function parseVersion(text) {
  const [engine, signatures, date] = String(text).trim().split("/");
  const when = date ? new Date(date) : null;
  return {
    engine: engine?.replace(/^ClamAV\s*/i, "") || null,
    signatures: signatures && /^\d+$/.test(signatures) ? Number(signatures) : null,
    signaturesDate: when && !Number.isNaN(when.getTime()) ? when.toISOString() : null,
  };
}

export function createScanner(setting = process.env.GATEWAY_CLAMAV) {
  const parsed = parseClamAddress(setting);
  const off = !!parsed?.off;
  const candidates = off ? [] : parsed ? [parsed] : [...KNOWN_SOCKETS.map((p) => ({ path: p })), { host: "127.0.0.1", port: 3310 }];
  let address = null; // the one that answered
  const state = { available: false, everSeen: false, version: null, checkedAt: null, error: null };
  let onUnavailable = null; // told straight away when a scan finds ClamAV gone

  const describe = (a) => (a.path ? a.path : `${a.host}:${a.port}`);
  const connect = (a) => (a.path ? net.createConnection({ path: a.path }) : net.createConnection({ host: a.host, port: a.port }));

  // One short command ("zVERSION", "zPING"), one reply
  function command(a, cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (a.path) {
        // stat, not existsSync: a folder this user can't open must say "not allowed", not "not there"
        try {
          fs.statSync(a.path);
        } catch (err) {
          return reject(Object.assign(new Error(err.code === "ENOENT" ? "no socket" : err.message), { code: err.code }));
        }
      }
      const sock = connect(a);
      const parts = [];
      sock.setTimeout(timeoutMs, () => sock.destroy(new Error("ClamAV didn't answer in time")));
      sock.on("connect", () => sock.write(`z${cmd}\0`));
      sock.on("data", (d) => parts.push(d));
      sock.on("error", reject);
      sock.on("close", () => resolve(Buffer.concat(parts).toString("utf8").replace(/\0/g, "").trim()));
    });
  }

  // Why ClamAV can't be used, in words that say what to do. The most telling failure wins: a socket
  // that's there but refuses this user says more than the addresses that simply don't exist.
  let lastLogged = null;
  function whyNot(tries) {
    const user = (() => {
      try {
        return os.userInfo().username;
      } catch {
        return "the gateway's user";
      }
    })();
    const denied = tries.find((e) => e.code === "EACCES" || e.code === "EPERM");
    if (denied) {
      return `ClamAV is running, but the gateway (user ${user}) isn't allowed to use its socket ${describe(denied.address)}. Add ${user} to the clamav group (sudo usermod -aG clamav ${user}) and restart the gateway.`;
    }
    const socketThere = tries.find((e) => e.address?.path && e.code !== "ENOENT");
    if (socketThere) return `ClamAV's socket ${describe(socketThere.address)} is there but isn't answering (${socketThere.message}). It may still be loading its signatures: that takes a minute or two after it starts, longer with little memory.`;
    const tcp = tries.find((e) => e.address?.host && e.code !== "ECONNREFUSED");
    if (tcp) return `ClamAV at ${describe(tcp.address)} isn't answering (${tcp.message}).`;
    if (parsed) return `ClamAV isn't answering at ${describe(parsed)}: ${tries[0]?.message ?? "no reply"}.`;
    return state.everSeen
      ? "ClamAV stopped: its socket is gone. Check it's running (systemctl status clamav-daemon); it may be loading its signatures, or out of memory."
      : "ClamAV isn't running on this gateway (no socket at its usual places). If it's installed, it may still be loading its signatures, or be stopping for lack of memory: systemctl status clamav-daemon";
  }

  // Is ClamAV there, and which signatures does it have? Called every few minutes by the monitor.
  async function check() {
    if (off) return status();
    const order = address ? [address, ...candidates.filter((c) => c !== address)] : candidates;
    let lastErr = null;
    const tries = []; // why each address didn't work
    for (const a of order) {
      try {
        const reply = await command(a, "VERSION");
        let version = null;
        if (/^ClamAV/i.test(reply)) version = parseVersion(reply);
        else if (/COMMAND UNAVAILABLE/i.test(reply)) {
          // VERSION switched off in clamd.conf (EnableVersionCommand no): PING can't be, and says it's alive.
          // Scanning works the same; only the signature version isn't known (so no rescan on new ones).
          const pong = await command(a, "PING");
          if (!/^PONG/i.test(pong)) throw new Error(`unexpected reply: ${pong.slice(0, 80)}`);
          if (!state.versionHidden) log.info("Antivirus: ClamAV's VERSION command is turned off (EnableVersionCommand no); checking it with PING instead");
          state.versionHidden = true;
        } else throw new Error(`unexpected reply: ${reply.slice(0, 80)}`);
        if (address !== a) log.info(`Antivirus: ClamAV found at ${describe(a)}`);
        address = a;
        Object.assign(state, { available: true, everSeen: true, version, error: null });
        state.checkedAt = new Date().toISOString();
        return status();
      } catch (err) {
        err.address = a;
        tries.push(err);
        lastErr = err;
      }
    }
    if (state.available) log.error(`Antivirus: ClamAV stopped answering (${lastErr?.message})`);
    state.available = false;
    state.checkedAt = new Date().toISOString();
    state.error = whyNot(tries);
    if (state.error !== lastLogged) log.warn(`Antivirus: ${state.error}`);
    lastLogged = state.error;
    return status();
  }

  // Start scanning one file: write() its content piece by piece, then end() for the verdict.
  // Never throws: problems come back as { status: "pending" } so the backup itself isn't lost.
  function stream() {
    if (off || !state.everSeen) return dummy("off");
    if (!state.available || !address) return dummy("pending", "ClamAV is down");
    const started = Date.now();
    let bytes = 0;
    let reply = "";
    let failure = null;
    let closed = false;
    const sock = connect(address);
    sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error("ClamAV took too long")));
    sock.on("data", (d) => (reply += d.toString("utf8")));
    sock.on("error", (err) => (failure ??= err));
    const done = new Promise((resolve) => sock.on("close", () => { closed = true; resolve(); }));
    sock.write("zINSTREAM\0");

    async function send(buf) {
      if (closed) return; // clamd already answered (e.g. size limit): the rest isn't needed
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length);
      const ok = sock.write(Buffer.concat([len, buf]));
      if (!ok && !closed) await new Promise((r) => { sock.once("drain", r); sock.once("close", r); });
    }

    return {
      async write(data) {
        bytes += data.length;
        for (let i = 0; i < data.length; i += PIECE) await send(data.subarray(i, i + PIECE));
      },
      async end() {
        if (!closed) sock.write(Buffer.alloc(4)); // zero length: that's the whole file
        await done;
        const ms = Date.now() - started;
        const text = reply.replace(/\0/g, "").trim();
        let m;
        if ((m = text.match(/^stream: (.+) FOUND$/))) return { status: "infected", signature: m[1].slice(0, 200), bytes, ms };
        if (/^stream: OK$/.test(text)) return { status: "clean", bytes, ms };
        if (/size limit exceeded/i.test(text)) return { status: "too-big", bytes, ms };
        const message = (failure?.message || text || "no answer").slice(0, 200);
        log.warn(`Antivirus: scan failed (${message}); it'll be scanned again`);
        if (state.available) {
          state.available = false; // re-checked by the monitor
          state.error = `ClamAV stopped answering: ${message}`;
          onUnavailable?.(message);
        }
        return { status: "pending", message, bytes, ms };
      },
      abort() {
        sock.destroy();
      },
    };
  }

  function dummy(statusValue, message) {
    let bytes = 0;
    return {
      async write(d) { bytes += d.length; },
      async end() { return { status: statusValue, message, bytes, ms: 0 }; },
      abort() {},
    };
  }

  function status() {
    return {
      enabled: !off,
      available: state.available,
      address: off ? null : describe(address ?? candidates[0]),
      engine: state.version?.engine ?? null,
      signatures: state.version?.signatures ?? null,
      signaturesDate: state.version?.signaturesDate ?? null,
      checkedAt: state.checkedAt,
      // VERSION turned off in clamd.conf: scanning works, the signature version just isn't shown
      versionHidden: !!state.versionHidden,
      error: off ? null : state.error,
    };
  }

  return { check, stream, status, onUnavailable: (fn) => (onUnavailable = fn), get usable() { return !off && state.available; }, get everSeen() { return state.everSeen; } };
}
