// Re-applies the database objects that live in migration SQL but cannot be
// expressed in schema.prisma.
//
// Why this exists: `prisma db push` syncs the database to schema.prisma and does
// NOT read prisma/migrations, so it silently DROPS anything the schema file
// can't describe. That includes the case-insensitive Tag index and nine CHECK
// constraints protecting ratings, counters, episode dates and non-negative
// season/episode fields. Losing any of them makes a db:push database less safe
// than a migration-built database.
//
// Idempotent: safe to run against a database that already has everything.
// Wired into the `db:push` npm script so the convenience path can't regress.
// `db:migrate` / `db:deploy` don't need it — they apply the migration SQL itself.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "ensure-indexes: neither DIRECT_URL nor DATABASE_URL is set in .env.local, .env, or the process environment.",
  );
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Mirrors prisma/migrations/20260717221157_workflow_foundation/migration.sql.
// These are fixed source literals, not caller input. PostgreSQL has no
// `ADD CONSTRAINT IF NOT EXISTS`, so each addition is guarded through
// pg_constraint and scoped to the owning table's regclass.
const checks = [
  {
    table: "Title",
    name: "Title_rating_domain_check",
    expression:
      '"rating" IS NULL OR ("rating" >= 0.5 AND "rating" <= 10 AND "rating" * 2 = floor("rating" * 2))',
  },
  {
    table: "Title",
    name: "Title_watchedEpisodes_nonneg_check",
    expression: '"watchedEpisodes" >= 0',
  },
  {
    table: "Title",
    name: "Title_totalEpisodes_nonneg_check",
    expression: '"totalEpisodes" IS NULL OR "totalEpisodes" >= 0',
  },
  {
    table: "Title",
    name: "Title_totalSeasons_nonneg_check",
    expression: '"totalSeasons" IS NULL OR "totalSeasons" >= 0',
  },
  {
    table: "Title",
    name: "Title_watched_le_total_check",
    expression: '"totalEpisodes" IS NULL OR "watchedEpisodes" <= "totalEpisodes"',
  },
  {
    table: "Episode",
    name: "Episode_episodeNumber_nonneg_check",
    expression: '"episodeNumber" >= 0',
  },
  {
    table: "Episode",
    name: "Episode_runtime_nonneg_check",
    expression: '"runtime" IS NULL OR "runtime" >= 0',
  },
  {
    table: "Episode",
    name: "Episode_watched_date_check",
    expression: '"watched" = true OR "watchedAt" IS NULL',
  },
  {
    table: "Season",
    name: "Season_seasonNumber_nonneg_check",
    expression: '"seasonNumber" >= 0',
  },
];

try {
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_lower_name_key"
    ON "Tag" ("userId", lower("name"))
  `);
  for (const check of checks) {
    await prisma.$executeRawUnsafe(`
      DO $celluloid$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = '${check.name}'
            AND conrelid = '"${check.table}"'::regclass
        ) THEN
          ALTER TABLE "${check.table}"
          ADD CONSTRAINT "${check.name}" CHECK (${check.expression});
        END IF;
      END
      $celluloid$
    `);
  }
  console.log(
    'ensure-indexes: Tag index and 9 integrity constraints are present.',
  );
} catch (error) {
  console.error("ensure-indexes: failed to apply database objects.", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
