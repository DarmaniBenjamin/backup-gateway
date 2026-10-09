// Reads a file in fixed 1 MiB pieces without loading the whole file into memory.

import fs from "node:fs/promises";
import { CHUNK_SIZE } from "./crypto-box.js";

export async function* readChunks(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    while (true) {
      const buffer = Buffer.alloc(CHUNK_SIZE);
      let filled = 0;
      // Keep reading until the chunk is full or the file ends
      while (filled < CHUNK_SIZE) {
        const { bytesRead } = await handle.read(buffer, filled, CHUNK_SIZE - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) return;
      yield buffer.subarray(0, filled);
      if (filled < CHUNK_SIZE) return;
    }
  } finally {
    await handle.close();
  }
}