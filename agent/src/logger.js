// Simple logger with timestamps and levels.
// Later this will also send logs to the gateway.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const currentLevel = LEVELS[process.env.AGENT_LOG_LEVEL] ?? LEVELS.info;

function write(level, message, extra) {
  if (LEVELS[level] < currentLevel) return;
  const time = new Date().toISOString();
  const line = `${time} [${level.toUpperCase()}] ${message}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (extra !== undefined) out(line, extra);
  else out(line);
}

export const log = {
  debug: (msg, extra) => write("debug", msg, extra),
  info: (msg, extra) => write("info", msg, extra),
  warn: (msg, extra) => write("warn", msg, extra),
  error: (msg, extra) => write("error", msg, extra),
};