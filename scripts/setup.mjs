// Prepares the database for the current code: generates the Prisma client and
// applies pending migrations. Used by `npm run setup`.
//
// `prisma generate` can fail on the server with EPERM when files in
// node_modules/.prisma belong to another user. The generated folder is then
// removed and generated again. Migrations are always applied, even when
// generating fails, because the app cannot run against a database that is
// missing columns. The script exits with an error if anything is left undone.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function prisma(args) {
  execFileSync("npx", ["prisma", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

let generated = false;
try {
  prisma(["generate"]);
  generated = true;
} catch {
  console.warn("\nprisma generate failed. Removing node_modules/.prisma and trying again...\n");
  try {
    fs.rmSync(path.resolve("node_modules", ".prisma"), { recursive: true, force: true });
    prisma(["generate"]);
    generated = true;
  } catch (error) {
    console.error(`\nprisma generate failed again: ${error.message}`);
  }
}

let migrated = false;
try {
  prisma(["migrate", "deploy"]);
  migrated = true;
} catch (error) {
  console.error(`\nprisma migrate deploy failed: ${error.message}`);
  console.error('If it mentions P3018 or "duplicate column", run: node scripts/repair-migrations.mjs');
}

if (!generated || !migrated) {
  console.error(
    `\nSetup is NOT complete (client generated: ${generated ? "yes" : "no"}, migrations applied: ${migrated ? "yes" : "no"}). Do not restart the app until this is fixed.`,
  );
  process.exit(1);
}

console.log("\nSetup complete: Prisma client generated and all migrations applied.");
