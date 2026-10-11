// Synology only: exports the NAS's DSM settings (users, groups, shared folders and their
// permissions, network, services...) once a day with Synology's own tool, into one file:
//
//   /volumeN/@backup-agent/DSM-settings/dsm-settings.dss
//
// Back that folder up (the device's page offers it) and every day's export becomes a version, so
// a NAS can be rebuilt with its settings from any day: in DSM, Control Panel > Update & Restore >
// Configuration Backup > Restore, with the .dss file.
// The installer sets AGENT_DSM_EXPORT_DIR; elsewhere this does nothing.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

const TOOL = "/usr/syno/bin/synoconfbkp";
const EVERY_MS = 24 * 3600 * 1000;
const FIRST_AFTER_MS = 2 * 60 * 1000;

export function createDsmExport({ dir = process.env.AGENT_DSM_EXPORT_DIR?.trim() || null, tool = TOOL } = {}) {
  const enabled = !!dir && fs.existsSync(tool);
  const state = { lastAt: null, error: null };
  let timer = null;

  function run() {
    return new Promise((resolve) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Written under a .tmp name (never backed up), then swapped in, so a half-written export is never sent
      const tmp = path.join(dir, `dsm-settings.${process.pid}.tmp`);
      execFile(tool, ["export", `--filepath=${tmp}`], { timeout: 10 * 60_000 }, (err, stdout, stderr) => {
        try {
          if (err) throw new Error((stderr || err.message).trim().split("\n")[0]);
          if (!fs.statSync(tmp, { throwIfNoEntry: false })?.size) throw new Error("the export file is empty");
          fs.renameSync(tmp, path.join(dir, "dsm-settings.dss"));
          state.lastAt = new Date().toISOString();
          state.error = null;
          log.info("DSM settings exported for backup");
        } catch (e) {
          fs.rmSync(tmp, { force: true });
          state.error = e.message;
          log.warn(`Couldn't export the DSM settings: ${e.message}`);
        }
        resolve();
      });
    });
  }

  return {
    enabled,
    dir: enabled ? dir : null,
    start() {
      if (!enabled) return;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      setTimeout(run, FIRST_AFTER_MS).unref();
      timer = setInterval(run, EVERY_MS);
      timer.unref();
    },
    stop: () => clearInterval(timer),
    status: () => (enabled ? { dir, lastAt: state.lastAt, error: state.error } : null),
    run,
  };
}
