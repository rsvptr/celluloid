// Repairs advance-published episode rows created before CEL-2. The old sync
// stamped those rows with the day TMDB first advertised them, which could let
// the 14-day "New episodes" window expire before their air date. The corrected
// sync uses the air date itself, so this script brings existing rows in line.
//
// Idempotent: after an affected row has discoveredAt = airDate it no longer
// matches the strict airDate > discoveredAt predicate. This is a production
// data backfill, deliberately NOT wired into an npm lifecycle or migration.
//
// Usage: npm run db:backfill:discovered-at -- --target dev|prod
//   dev   the migration URL (DIRECT_URL, DATABASE_URL_UNPOOLED, DATABASE_URL)
//   prod  PROD_DATABASE_URL, on its direct host
// Add --yes only after checking the printed target.

import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { resolveMigrationTarget, toDirectUrl } from "./db-urls.mjs";
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

export function parseArgs(argv) {
  let target;
  let yes = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    let value;
    if (arg === "--target") {
      index += 1;
      value = argv[index];
    } else if (arg.startsWith("--target=")) {
      value = arg.slice("--target=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (target !== undefined) throw new Error("--target may be supplied only once.");
    if (value !== "dev" && value !== "prod") {
      throw new Error("--target requires either dev or prod.");
    }
    target = value;
  }
  if (target === undefined) throw new Error("An explicit --target dev|prod is required.");
  return { target, yes };
}

/**
 * dev uses the same direct URL as migrations. A DIRECT_URL or
 * DATABASE_URL_UNPOOLED on another branch than DATABASE_URL is refused rather
 * than warned about: this writes data, and nothing else would stop it from
 * landing on that branch. prod reads PROD_DATABASE_URL only, as db:dump and
 * db:deploy:prod do, so production is never reached through DATABASE_URL.
 */
export function resolveTarget(target, env) {
  if (target === "prod") {
    if (!env.PROD_DATABASE_URL) {
      throw new Error("PROD_DATABASE_URL is not set in .env.local, .env, or the process environment.");
    }
    return {
      connectionString: toDirectUrl(env.PROD_DATABASE_URL),
      label: "PRODUCTION",
      source: "PROD_DATABASE_URL",
    };
  }
  const { url, source, mismatch } = resolveMigrationTarget(env);
  if (mismatch) throw new Error(`Refusing to backfill. ${mismatch}`);
  if (!url) {
    throw new Error(
      "None of DIRECT_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is set in .env.local, .env, or the process environment.",
    );
  }
  return { connectionString: url, label: "DEVELOPMENT", source };
}

async function confirmBackfill(skipConfirmation, label) {
  if (skipConfirmation) return true;
  if (!stdin.isTTY) {
    throw new Error(
      "Refusing to backfill: stdin is not interactive. Re-run in a terminal, or pass --yes after verifying the printed target.",
    );
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`Type "backfill" to update ${label}: `);
  rl.close();
  return answer.trim() === "backfill";
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { target, yes } = parseArgs(argv);
  const { connectionString, label, source } = resolveTarget(target, env);

  console.log(
    `About to repair advance-published episode dates in ${label} (${source}): ${describeTarget(connectionString)}`,
  );
  if (!(await confirmBackfill(yes, label))) {
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
