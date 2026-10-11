// Packs the agent (its code and installers) into a .tar.gz (Linux, Mac) and a .zip (Windows) that
// new devices download during a one-line install. Built once when the gateway starts; the SHA-256
// goes into every install script, so a device only runs the package if it arrived unchanged.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const SKIP = new Set(["node_modules", "data", ".env", ".git"]);

function listFiles(root, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, relPath));
    else if (entry.isFile()) out.push(relPath);
  }
  return out.sort();
}

// One 512-byte tar (ustar) header
function tarHeader(name, size, mode, mtime) {
  if (Buffer.byteLength(name) > 100) throw new Error(`Path too long for the agent package: ${name}`);
  const h = Buffer.alloc(512);
  const field = (value, offset, length) => h.write(value, offset, length, "utf8");
  const octal = (value, offset, length) => field(value.toString(8).padStart(length - 1, "0") + "\0", offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8); // uid: root
  octal(0, 116, 8); // gid: root
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  field("        ", 148, 8); // checksum placeholder (spaces) while summing
  field("0", 156, 1); // regular file
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  field("root", 265, 32);
  field("root", 297, 32);
  let sum = 0;
  for (const byte of h) sum += byte;
  field(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return h;
}

// A .zip of the same files, for Windows (Expand-Archive is built into every Windows PowerShell)
function zipOf(entries, mtime) {
  const d = new Date(mtime * 1000);
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

export function buildAgentPackage(agentDir) {
  if (!fs.existsSync(path.join(agentDir, "package.json")) || !fs.existsSync(path.join(agentDir, "install", "linux", "install.sh"))) {
    return null;
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf8"));
  const mtime = Math.floor(Date.now() / 1000);
  const parts = [];
  const entries = [];
  for (const rel of listFiles(agentDir)) {
    const data = fs.readFileSync(path.join(agentDir, rel));
    entries.push({ name: `agent/${rel}`, data });
    parts.push(tarHeader(`agent/${rel}`, data.length, rel.endsWith(".sh") ? 0o755 : 0o644, mtime));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024)); // end of archive
  const tarGz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  const zip = zipOf(entries, mtime);
  const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
  return { version, tarGz, sha256: sha(tarGz), zip, zipSha256: sha(zip) };
}
