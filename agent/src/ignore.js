// Rules for files and folders the agent never backs up.

import path from "node:path";

// Names we never back up (matched against each part of the path)
const IGNORED_NAMES = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "@eaDir",        // Synology thumbnails/metadata
  "#recycle",      // Synology recycle bin
  "#snapshot",     // Synology snapshots
  "$RECYCLE.BIN",  // Windows recycle bin
  "System Volume Information",
  "node_modules",
]);

export function isIgnored(filePath) {
  const parts = filePath.split(/[\\/]/);
  for (const part of parts) {
    if (IGNORED_NAMES.has(part)) return true;
  }
  const name = path.basename(filePath);
  if (name.startsWith("~$")) return true;                          // Office lock/temp files
  if (name.startsWith(".~lock.")) return true;                     // LibreOffice lock files
  if (/\.(tmp|temp|part|crdownload|swp)$/i.test(name)) return true; // temp/partial downloads
  return false;
}