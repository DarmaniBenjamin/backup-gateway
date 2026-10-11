// Builds the Windows setup program (BackupAgentSetup.exe) from setup-exe/ into bin/.
// Needs Go (https://go.dev, or "sudo pacman -S go" / "sudo apt install golang"). Go builds the
// Windows .exe from any computer; no Windows needed. Restart the gateway afterwards.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "bin", "BackupAgentSetup.exe");

const go = spawnSync("go", ["version"], { encoding: "utf8" });
if (go.error) {
  console.error("Go isn't installed. Install it (Arch: sudo pacman -S go, Debian/Ubuntu: sudo apt install golang), then run this again.");
  process.exit(1);
}
console.log(`Building with ${go.stdout.trim()}...`);

fs.mkdirSync(path.dirname(out), { recursive: true });
const build = spawnSync("go", ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "."], {
  cwd: path.join(root, "setup-exe"),
  stdio: "inherit",
  env: { ...process.env, GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0", GOFLAGS: "-mod=mod" },
});
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(`✔ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB). Restart the gateway to use it.`);
