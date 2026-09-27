/**
 * CI check, run after `prisma migrate deploy`, that the objects living only in
 * migration SQL exist: the Tag ("userId", lower(name)) unique index and the
 * CHECK constraints. `prisma migrate diff` leaves expression indexes and CHECKs
 * out of its comparison, so a migration that dropped one would otherwise pass
 * the drift job.
 *
 * The expected CHECKs are read from the migration that created them, the same
 * list tests/ensure-database-objects.test.ts holds scripts/ensure-indexes.mjs
 * to. Connects to the migration URL, and refuses on a same-branch mismatch.
 *
 * Usage: node scripts/check-migration-objects.mjs
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { resolveMigrationTarget } from "./db-urls.mjs";

export const TAG_INDEX = "Tag_userId_lower_name_key";

export const MIGRATION_SQL = new URL(
  "../prisma/migrations/20260717221157_workflow_foundation/migration.sql",
  import.meta.url,
);

/** The CHECK constraints the migration adds, as { table, name }. */
export function migratedChecks(sql = readFileSync(MIGRATION_SQL, "utf8")) {
  return [...sql.matchAll(/ALTER TABLE "([^"]+)" ADD CONSTRAINT "([^"]+_check)"/g)].map(
    ([, table, name]) => ({ table, name }),
  );
}

/**
 * Descriptions of the expected objects the database lacks.
 *
 * @param {{ table: string, name: string }[]} checks expected CHECK constraints
 * @param {{ table: string, name: string }[]} constraints CHECK constraints present
 * @param {{ table: string, indexdef: string } | undefined} tagIndex pg_indexes row for TAG_INDEX
 */
export function missingObjects(checks, constraints, tagIndex) {
  const present = new Set(constraints.map(({ table, name }) => `${table}.${name}`));
  const missing = checks
    .filter(({ table, name }) => !present.has(`${table}.${name}`))
    .map(({ table, name }) => `CHECK constraint ${name} on "${table}"`);
  if (
    tagIndex?.table !== "Tag" ||
    !/^CREATE UNIQUE INDEX .*\("userId", lower\(name\)\)$/.test(tagIndex.indexdef)
  ) {
    missing.push(`unique index ${TAG_INDEX} on "Tag" ("userId", lower(name))`);
  }
  return missing;
}

async function main() {
  const { url, mismatch } = resolveMigrationTarget();
  if (mismatch) throw new Error(mismatch);
  if (!url) throw new Error("None of DIRECT_URL, DATABASE_URL_UNPOOLED or DATABASE_URL is set.");

  const checks = migratedChecks();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let missing;
  try {
    const constraints = await client.query(
      `SELECT t.relname AS "table", c.conname AS name
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE c.contype = 'c' AND t.relnamespace = current_schema()::regnamespace`,
    );
    const index = await client.query(
      `SELECT tablename AS "table", indexdef
         FROM pg_indexes
        WHERE schemaname = current_schema() AND indexname = $1`,
      [TAG_INDEX],
    );
    missing = missingObjects(checks, constraints.rows, index.rows[0]);
  } finally {
    await client.end();
  }

  if (missing.length > 0) {
    throw new Error(
      `the migrated database is missing objects that only migration SQL creates:\n${missing
        .map((item) => `  ${item}`)
        .join("\n")}`,
    );
  }
  console.log(
    `check-migration-objects: ${TAG_INDEX} and all ${checks.length} CHECK constraints are present.`,
  );
}

const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main();
  } catch (error) {
    console.error("check-migration-objects:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
