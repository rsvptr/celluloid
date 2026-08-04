// Repairs advance-published episode rows created before CEL-2. The old sync
// stamped those rows with the day TMDB first advertised them, which could let
// the 14-day "New episodes" window expire before their air date. The corrected
// sync uses the air date itself, so this script brings existing rows in line.
//
// Idempotent: after an affected row has discoveredAt = airDate it no longer
// matches the strict airDate > discoveredAt predicate. This is a production
// data backfill, deliberately NOT wired into an npm lifecycle or migration.
// Run it only after the owner explicitly approves the target database.

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "backfill-discovered-at: neither DIRECT_URL nor DATABASE_URL is set. Load your env first.",
  );
  process.exit(1);
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
} catch (error) {
  console.error("backfill-discovered-at: failed to repair episode rows.", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
