// Repairs advance-published episode rows created before CEL-2. The old sync
// stamped those rows with the day TMDB first advertised them, which could let
// the 14-day "New episodes" window expire before their air date. The corrected
// sync uses the air date itself, so this script brings existing rows in line.
//
// Idempotent: after an affected row has discoveredAt = airDate it no longer
// matches the strict airDate > discoveredAt predicate. This is a production
// data backfill, deliberately NOT wired into an npm lifecycle or migration.
//
// Usage: npm run db:backfill:discovered-at   (add -- --yes after checking the target)

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { loadEnv } from "./load-env.mjs";

/** Credentials and query parameters are deliberately excluded. */
export function describeTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("The selected database URL is not a valid URL.");
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname) {
    throw new Error("The selected database URL must be a PostgreSQL connection string.");
  }
  return `${parsed.host}${parsed.pathname}`;
}

async function confirmBackfill(skipConfirmation) {
  if (skipConfirmation) return true;
  if (!stdin.isTTY) {
    throw new Error(
      "Refusing to backfill: stdin is not interactive. Re-run in a terminal, or pass --yes after verifying the printed target.",
    );
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Type "backfill" to continue: ');
  rl.close();
  return answer.trim() === "backfill";
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const unknown = argv.filter((arg) => arg !== "--yes");
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown[0]}`);

  const connectionString = env.DIRECT_URL ?? env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "Neither DIRECT_URL nor DATABASE_URL is set in .env.local, .env, or the process environment.",
    );
  }

  const target = describeTarget(connectionString);
  console.log(`About to repair advance-published episode dates in: ${target}`);
  if (!(await confirmBackfill(argv.includes("--yes")))) {
    console.log("Aborted; nothing was changed.");
    return;
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const updated = await prisma.$executeRawUnsafe(`
      UPDATE "Episode"
      SET "discoveredAt" = "airDate"
      WHERE "airDate" IS NOT NULL
        AND "airDate" > "discoveredAt"
    `);
    console.log(`backfill-discovered-at: repaired ${updated} episode row(s).`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  loadEnv();
  try {
    await main();
  } catch (error) {
    console.error(
      "backfill-discovered-at: failed:",
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}
