// Rebuilds the Windows setup program (setup-exe/BackupAgentSetup.exe) from setup-exe/setup.c and
// setup.rc (its administrator manifest and version details).
// A built copy is already in the repo, so this is only needed after changing those files.
//
// Needs Zig, which builds Windows programs from any computer (no Windows needed):
//   sudo pacman -S zig     (or: pip install ziglang / https://ziglang.org/download)
// Restart the gateway afterwards.
//
// To code-sign it (recommended, see README "The Windows setup program"), sign the built file and
// keep the signed copy in setup-exe/: the gateway serves that exact file to everyone.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "setup-exe");
const out = path.join(dir, "BackupAgentSetup.exe");

function findZig() {
  for (const cmd of [["zig"], ["python3", "-m", "ziglang"], ["python", "-m", "ziglang"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return { cmd, version: r.stdout.trim() };
  }
  return null;
}

const zig = findZig();
if (!zig) {
  console.error("Zig isn't installed. Install it with:  sudo pacman -S zig   (or: pip install ziglang), then run this again.");
  process.exit(1);
}
console.log(`Building with Zig ${zig.version}...`);

const r = spawnSync(
  zig.cmd[0],
  [
    ...zig.cmd.slice(1),
    "cc",
    "-target", "x86_64-windows-gnu",
    "-Os", "-s", "-municode", "-Wall",
    "setup.c", "setup.rc",
    "-lwinhttp", "-lbcrypt", "-lshell32",
    "-o", out,
  ],
  { stdio: "inherit", cwd: dir }
);
if (r.status !== 0) process.exit(r.status ?? 1);
for (const extra of ["BackupAgentSetup.pdb", "BackupAgentSetup.lib"]) fs.rmSync(path.join(dir, extra), { force: true });
console.log(`✔ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB). Restart the gateway to use it.`);
