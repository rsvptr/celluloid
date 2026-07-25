// Re-applies the database objects that live in migration SQL but cannot be
// expressed in schema.prisma.
//
// Why this exists: `prisma db push` syncs the database to schema.prisma and does
// NOT read prisma/migrations, so it silently DROPS anything the schema file
// can't describe. Exactly one such object exists — the case-insensitive unique
// index on Tag — and losing it is not cosmetic: findOrCreateTag (src/lib/actions.ts)
// looks tags up case-insensitively and relies on that index to reject a
// concurrent create of a case variant. Without it you can end up with both
// "Horror" and "horror" for one user, after which bulkRemoveTag removes only one
// of them and the tag filter shows two entries for what the user considers one tag.
//
// Idempotent: safe to run against a database that already has everything.
// Wired into the `db:push` npm script so the convenience path can't regress.
// `db:migrate` / `db:deploy` don't need it — they apply the migration SQL itself.

// Loaded exactly as prisma.config.ts and scripts/import-excel.ts do. Without it
// this runs under plain node with no env: `prisma db push` reads .env through
// its own config and drops the index, then this step exits before restoring it,
// leaving the database in the one state the script exists to prevent.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const connectionString = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    "ensure-indexes: neither DIRECT_URL nor DATABASE_URL is set. Load your .env first.",
  );
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

try {
  // Mirrors prisma/migrations/20260717221157_workflow_foundation/migration.sql.
  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "Tag_userId_lower_name_key"
    ON "Tag" ("userId", lower("name"))
  `);
  console.log('ensure-indexes: "Tag_userId_lower_name_key" is present.');
} catch (error) {
  console.error("ensure-indexes: failed to apply index.", error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
