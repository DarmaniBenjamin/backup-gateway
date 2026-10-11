// Rebuilds the Windows setup program (setup-exe/BackupAgentSetup.exe) from setup-exe/setup.c.
// A built copy is already in the repo, so this is only needed after changing setup.c.
//
// Needs Zig, which builds Windows programs from any computer (no Windows needed):
//   pip install ziglang     (or: sudo pacman -S zig / https://ziglang.org/download)
// Restart the gateway afterwards.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "setup-exe", "setup.c");
const out = path.join(root, "setup-exe", "BackupAgentSetup.exe");

// The only Windows functions the program uses (it links to nothing else, not even a C runtime)
const IMPORTS = {
  kernel32: [
    "CloseHandle", "CreateFileW", "CreateProcessW", "ExitProcess", "FlushConsoleInputBuffer", "GetExitCodeProcess",
    "GetFileSizeEx", "GetLastError", "GetModuleFileNameW", "GetStdHandle", "GetSystemDirectoryW", "MultiByteToWideChar",
    "ReadConsoleW", "ReadFile", "SetConsoleTitleW", "SetFilePointerEx", "WaitForSingleObject", "WriteConsoleW",
    "lstrcatW", "lstrcmpA", "lstrcpyW", "lstrlenA", "lstrlenW",
  ],
  shell32: ["IsUserAnAdmin", "ShellExecuteW"],
};

function findZig() {
  for (const cmd of [["zig"], ["python3", "-m", "ziglang"], ["python", "-m", "ziglang"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return { cmd, version: r.stdout.trim() };
  }
  return null;
}

const zig = findZig();
if (!zig) {
  console.error("Zig isn't installed. Install it with:  pip install ziglang   (or: sudo pacman -S zig), then run this again.");
  process.exit(1);
}
console.log(`Building with Zig ${zig.version}...`);

const run = (args) => {
  const r = spawnSync(zig.cmd[0], [...zig.cmd.slice(1), ...args], { stdio: "inherit", cwd: tmp });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "setup-exe-"));
try {
  for (const [dll, names] of Object.entries(IMPORTS)) {
    fs.writeFileSync(path.join(tmp, `${dll}.def`), `LIBRARY ${dll}.dll\nEXPORTS\n${names.join("\n")}\n`);
    run(["dlltool", "-m", "i386:x86-64", "-d", `${dll}.def`, "-l", `${dll}.lib`]);
  }
  run(["cc", "-target", "x86_64-windows-gnu", "-Os", "-fno-stack-protector", "-fno-builtin", "-mno-stack-arg-probe", "-c", "-o", "setup.o", src]);
  run([
    "lld-link", "/nologo", "/entry:start", "/subsystem:console", "/nodefaultlib", "/opt:ref", "/opt:icf",
    "/dynamicbase", "/nxcompat", "/highentropyva", "/Brepro", `/out:${out}`, "setup.o", "kernel32.lib", "shell32.lib",
  ]);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`✔ ${path.relative(process.cwd(), out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB). Restart the gateway to use it.`);
