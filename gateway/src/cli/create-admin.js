// Creates an admin account for the web UI, or resets an existing admin's password.
// The password is typed in hidden and never appears on screen or in your shell history.
//
// Usage: npm run create-admin -- YOUR_USERNAME

import readline from "node:readline";
import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { openAdminStore } from "../admin/admin-store.js";
import { hashPassword, checkPasswordStrength } from "../admin/passwords.js";

const username = (process.argv[2] ?? "").trim();
if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
  console.error("Usage: npm run create-admin -- YOUR_USERNAME");
  console.error("Username: 3-40 characters, letters, numbers, dot, dash or underscore.");
  process.exit(1);
}

const config = loadConfig();
openDatabase(config.dataDir).close(); // creates all tables on a brand-new install
const store = openAdminStore(config.dataDir);

// One reader for all questions. While "muted", typed characters are shown as *
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
rl._writeToOutput = (text) => {
  if (!muted) return rl.output.write(text);
  if (text.includes("\n") || text.includes("\r")) rl.output.write("\n");
  else rl.output.write("*".repeat(text.length));
};

// Typed lines wait in a queue, so nothing is lost even if pasted quickly
const lines = [];
const waiting = [];
rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
rl.on("close", () => waiting.splice(0).forEach((resolve) => resolve("")));

function askHidden(question) {
  rl.output.write(question);
  muted = true;
  return new Promise((resolve) => {
    const answer = (line) => {
      muted = false;
      rl.output.write("\n");
      resolve(line);
    };
    if (lines.length) answer(lines.shift());
    else waiting.push(answer);
  });
}

function finish(message, code = 0) {
  rl.close();
  store.close();
  (code === 0 ? console.log : console.error)(message);
  process.exit(code);
}

const existing = store.adminByName(username);
console.log(existing ? `\nResetting the password for "${username}".` : `\nCreating admin "${username}".`);
console.log("Use at least 12 characters with 3 of: lowercase, uppercase, numbers, symbols.\n");

const password = await askHidden("Password: ");
const problem = checkPasswordStrength(password);
if (problem) finish(`\n${problem}`, 1);
if ((await askHidden("Type it again: ")) !== password) finish("\nThe passwords don't match.", 1);

const hash = await hashPassword(password);
if (existing) {
  store.setPassword(existing.id, hash);
  store.audit("cli", "admin.password-reset", { username });
  finish(`\nPassword updated for "${username}". All their sessions were logged out.\n`);
} else {
  store.addAdmin(username, hash);
  store.audit("cli", "admin.created", { username });
  finish(`\nAdmin "${username}" created. Log in at http://127.0.0.1:8090\n`);
}