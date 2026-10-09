// Stores encrypted chunks on disk, one folder per device:
//   data/devices/<deviceId>/chunks/<first 2 chars>/<chunkId>
// Chunks are kept exactly as the agent sealed them, so they stay encrypted at rest.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function createStorage(dataDir) {
  const chunkPath = (deviceId, id) => path.join(dataDir, "devices", deviceId, "chunks", id.slice(0, 2), id);

  return {
    writeChunk(deviceId, id, box) {
      const finalPath = chunkPath(deviceId, id);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      // Write to a temp file first, then rename, so a crash never leaves a half-written chunk
      const tmpPath = `${finalPath}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      fs.writeFileSync(tmpPath, box, { mode: 0o600 });
      fs.renameSync(tmpPath, finalPath);
    },
    readChunk(deviceId, id) {
      return fs.readFileSync(chunkPath(deviceId, id));
    },
    deleteChunk(deviceId, id) {
      fs.rmSync(chunkPath(deviceId, id), { force: true });
    },
  };
}