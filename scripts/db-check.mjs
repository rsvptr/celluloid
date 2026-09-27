// Read-only data-hygiene scan ahead of the CHECK-constraint migration.
// Reports rows that would violate the planned constraints; writes nothing.
// Usage: npm run db:check
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { loadEnv } from "./load-env.mjs";

/** Runs every check and returns the offending rows, keyed by check. */
export async function scan(prisma) {
  const out = {};

  // Rating domain: null or 0.5..10 in half steps.
  out.badRatings = await prisma.$queryRaw`
    SELECT id, name, rating FROM "Title"
    WHERE rating IS NOT NULL AND (rating < 0.5 OR rating > 10 OR (rating * 2) <> floor(rating * 2))`;

  // Counter sanity.
  out.negativeCounters = await prisma.$queryRaw`
    SELECT id, name, "watchedEpisodes", "totalEpisodes", "totalSeasons" FROM "Title"
    WHERE "watchedEpisodes" < 0 OR COALESCE("totalEpisodes", 0) < 0 OR COALESCE("totalSeasons", 0) < 0`;
  out.watchedOverTotal = await prisma.$queryRaw`
    SELECT id, name, "watchedEpisodes", "totalEpisodes" FROM "Title"
    WHERE "totalEpisodes" IS NOT NULL AND "watchedEpisodes" > "totalEpisodes"`;

  // Episode consistency: unwatched rows carrying a watch date.
  out.unwatchedWithDate = await prisma.$queryRaw`
    SELECT id, "seasonId", "episodeNumber" FROM "Episode" WHERE watched = false AND "watchedAt" IS NOT NULL`;

  // Episode/season number sanity.
  out.badNumbers = await prisma.$queryRaw`
    SELECT e.id, e."episodeNumber", e.runtime FROM "Episode" e
    WHERE e."episodeNumber" < 0 OR COALESCE(e.runtime, 0) < 0`;

  // Tag case-duplicates (per user) ahead of the case-insensitive unique index.
  out.tagCaseDupes = await prisma.$queryRaw`
    SELECT "userId", lower(name) AS key, count(*) AS n FROM "Tag"
    GROUP BY "userId", lower(name) HAVING count(*) > 1`;

  // Title counter drift vs actual episode rows (informational, would be fixed by recompute).
  out.counterDrift = await prisma.$queryRaw`
    SELECT t.id, t.name, t."watchedEpisodes" AS counter, count(e.id) FILTER (WHERE e.watched) AS actual
    FROM "Title" t
    LEFT JOIN "Season" s ON s."titleId" = t.id
    -- Active episodes only, as the app counts them (ACTIVE_EPISODE_FILTER).
    LEFT JOIN "Episode" e ON e."seasonId" = s.id AND e."withdrawnAt" IS NULL
    WHERE t."mediaType" = 'TV'
    GROUP BY t.id, t.name, t."watchedEpisodes"
    HAVING t."watchedEpisodes" <> count(e.id) FILTER (WHERE e.watched)`;

  return out;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  loadEnv();

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("db-check: DATABASE_URL is not set in .env.local, .env, or the process environment.");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });
  const out = await scan(prisma);

  const summary = Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, Array.isArray(v) ? v.length : v]),
  );
  console.log(JSON.stringify({ summary, detail: out }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
  await prisma.$disconnect();
}
