// Packs the agent (its code and installers) into a .tar.gz that new devices download during a
// one-line install. Built once when the gateway starts; its SHA-256 goes into every install
// script, so a device only runs the package if it arrived unchanged.

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

export function buildAgentPackage(agentDir) {
  if (!fs.existsSync(path.join(agentDir, "package.json")) || !fs.existsSync(path.join(agentDir, "install", "linux", "install.sh"))) {
    return null;
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(agentDir, "package.json"), "utf8"));
  const mtime = Math.floor(Date.now() / 1000);
  const parts = [];
  for (const rel of listFiles(agentDir)) {
    const data = fs.readFileSync(path.join(agentDir, rel));
    parts.push(tarHeader(`agent/${rel}`, data.length, rel.endsWith(".sh") ? 0o755 : 0o644, mtime));
    parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024)); // end of archive
  const tarGz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
  return { version, tarGz, sha256: crypto.createHash("sha256").update(tarGz).digest("hex") };
}
