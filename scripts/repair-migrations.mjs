// Repairs the Prisma migration history when database columns were created with
// `prisma db push` instead of `prisma migrate deploy`.
//
// Symptom: `npm run setup` stops with P3018 "duplicate column name: ...".
//
// For every migration listed below the script looks at the real database:
//   - all of its columns exist  -> the migration is marked as applied
//   - some of its columns exist -> the missing ones are added, then it is marked as applied
//   - none of its columns exist -> it is left for `prisma migrate deploy` to apply
// A backup of the SQLite database is made first. Running it twice is safe.
//
// Usage (in the app folder):  node scripts/repair-migrations.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const MIGRATIONS = [
  {
    name: "20261021102927_kogan_task_ids",
    columns: [
      ["KoganProductLink", "lastTaskId"],
      ["SyncLog", "taskId"],
    ],
  },
  {
    name: "20261022041210_kogan_link_environment",
    columns: [["KoganProductLink", "koganHost"]],
  },
];

const DATABASE_FILE = path.resolve("prisma", "dev.sqlite");

function prismaCli(args) {
  execFileSync("npx", ["prisma", ...args], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

async function columnsOf(prisma, table) {
  const rows = await prisma.$queryRawUnsafe(`PRAGMA table_info("${table}")`);
  return new Set(rows.map((row) => row.name));
}

async function migrationState(prisma, name) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = ?`,
    name,
  );
  if (rows.some((row) => row.finished_at && !row.rolled_back_at)) return "applied";
  if (rows.some((row) => !row.finished_at && !row.rolled_back_at)) return "failed";
  return "missing";
}

async function main() {
  if (!fs.existsSync(DATABASE_FILE)) {
    throw new Error(`Database not found at ${DATABASE_FILE}. Run this script from the app folder.`);
  }

  const backup = `${DATABASE_FILE}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(DATABASE_FILE, backup);
  console.log(`Backup created: ${backup}`);

  // Point the client at exactly the file that was backed up.
  const prisma = new PrismaClient({
    datasources: { db: { url: `file:${DATABASE_FILE.replace(/\\/g, "/")}` } },
  });
  const toResolve = [];
  const toRollBack = [];

  try {
    for (const migration of MIGRATIONS) {
      const state = await migrationState(prisma, migration.name);
      if (state === "applied") {
        console.log(`[ok]      ${migration.name} is already applied`);
        continue;
      }

      const present = [];
      const missing = [];
      for (const [table, column] of migration.columns) {
        ((await columnsOf(prisma, table)).has(column) ? present : missing).push([table, column]);
      }

      if (present.length === 0) {
        console.log(`[pending] ${migration.name} will be applied by prisma migrate deploy`);
        if (state === "failed") toRollBack.push(migration.name);
        continue;
      }

      for (const [table, column] of missing) {
        console.log(`[repair]  adding missing column ${table}.${column}`);
        await prisma.$executeRawUnsafe(`ALTER TABLE "${table}" ADD COLUMN "${column}" TEXT`);
      }

      console.log(`[repair]  ${migration.name}: columns already exist, marking it as applied`);
      toResolve.push(migration.name);
    }
  } finally {
    await prisma.$disconnect();
  }

  for (const name of toRollBack) prismaCli(["migrate", "resolve", "--rolled-back", name]);
  for (const name of toResolve) prismaCli(["migrate", "resolve", "--applied", name]);

  console.log("\nApplying any remaining migrations...");
  prismaCli(["migrate", "deploy"]);
  console.log("\nDone. The database and its migration history are in sync.");
}

main().catch((error) => {
  console.error(`\nRepair failed: ${error.message}`);
  console.error("The database was not changed beyond what is logged above. The backup file is next to it.");
  process.exit(1);
});
