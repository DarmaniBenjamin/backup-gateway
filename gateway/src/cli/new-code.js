// Creates a one-time enrollment code for a client.
// Usage: npm run new-code -- "Client Name"

import { loadConfig } from "../config.js";
import { openDatabase } from "../db.js";
import { generateCode, hashCode } from "../codes.js";

const clientName = process.argv.slice(2).join(" ").trim();
if (!clientName) {
  console.error('Usage: npm run new-code -- "Client Name"');
  process.exit(1);
}

const config = loadConfig();
const db = openDatabase(config.dataDir);

const code = generateCode();
const expiresAt = new Date(Date.now() + config.codeTtlMinutes * 60 * 1000);
db.addCode(hashCode(code), clientName, expiresAt.toISOString());
db.close();

console.log(`\nEnrollment code for "${clientName}":\n`);
console.log(`    ${code}\n`);
console.log(`Valid once, until ${expiresAt.toLocaleString()}.`);
console.log("It is not stored anywhere in plain text — copy it now.\n");