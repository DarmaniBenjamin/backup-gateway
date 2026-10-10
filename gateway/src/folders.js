// Rules for backup folders, shared by the agent API and the admin API.
// A folder has a NAME (the first part of every backed-up path, e.g. "Documents") and a PATH on the
// device (e.g. C:\Users\Anna\Documents). Names never change once used, so history stays together.

import crypto from "node:crypto";

export const MAX_FOLDERS = 50;
export const MAX_EXCLUDES = 50;

export const newFolderId = () => `fld_${crypto.randomBytes(9).toString("base64url")}`;

export function isValidFolderName(name) {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    name === name.trim() &&
    !/[\\/\0]/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

export function isValidDevicePath(p) {
  return typeof p === "string" && p.length >= 1 && p.length <= 1024 && !p.includes("\0") && /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

// "C:\Users\Anna\Documents" -> "Documents", "/volume1/Accounting" -> "Accounting", "D:\" -> "Drive D"
export function folderNameFromPath(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? "";
  if (/^[A-Za-z]:$/.test(last)) return `Drive ${last[0].toUpperCase()}`;
  return (last || "Root").slice(0, 64);
}

// For comparing paths: same separators, no trailing separator, case-insensitive on Windows/Mac
function comparable(p, platform) {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  if (platform === "win32" || platform === "darwin") s = s.toLowerCase();
  return s;
}

// Two folders overlap if they're the same or one is inside the other
export function foldersOverlap(a, b, platform) {
  const x = comparable(a, platform);
  const y = comparable(b, platform);
  const inside = (child, parent) => child === parent || child.startsWith(parent === "/" ? "/" : `${parent}/`);
  return inside(x, y) || inside(y, x);
}

// Is `child` the same as, or inside, `parent`?
export function isInsidePath(child, parent, platform) {
  const c = comparable(child, platform);
  const p = comparable(parent, platform);
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

export const samePath = (a, b, platform) => comparable(a, platform) === comparable(b, platform);

// Exclusion patterns match file or folder NAMES: "*.mp4", "Cache", "~*", "Thumbs?.db"
export function cleanExcludes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    const p = String(raw).trim();
    if (!p) continue;
    if (p.length > 100 || /[\\/\0]/.test(p)) throw new Error(`"${p.slice(0, 40)}" isn't a valid pattern. Use names like *.mp4 or Cache, without slashes.`);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_EXCLUDES) throw new Error(`At most ${MAX_EXCLUDES} exclusion patterns per folder.`);
  return out;
}
