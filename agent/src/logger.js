// Simple logger with timestamps and levels.
// Writes to the console (systemd's journal on Linux). With AGENT_LOG_FILE set (the Windows and Mac
// installers set it, since nothing collects a background program's console there), lines also go
// to that file, which is kept under 5 MB: when it fills up, it becomes agent.log.1 and a new one starts.

import fs from "node:fs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

const currentLevel = LEVELS[process.env.AGENT_LOG_LEVEL] ?? LEVELS.info;
const logFile = process.env.AGENT_LOG_FILE?.trim() || null;
let logSize = null;

function toFile(line) {
  try {
    if (logSize === null) logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    if (logSize > MAX_LOG_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
      logSize = 0;
    }
    fs.appendFileSync(logFile, `${line}\n`);
    logSize += Buffer.byteLength(line) + 1;
  } catch {
    // The log file is a convenience; never let it stop backups
  }
}

function describe(extra) {
  if (extra instanceof Error) return extra.stack || extra.message;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

function write(level, message, extra) {
  if (LEVELS[level] < currentLevel) return;
  const time = new Date().toISOString();
  const line = `${time} [${level.toUpperCase()}] ${message}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) out(line, extra);
  else out(line);
  if (logFile) toFile(extra === undefined ? line : `${line} ${describe(extra)}`);
}

export const log = {
  debug: (msg, extra) => write("debug", msg, extra),
  info: (msg, extra) => write("info", msg, extra),
  warn: (msg, extra) => write("warn", msg, extra),
  error: (msg, extra) => write("error", msg, extra),
};
