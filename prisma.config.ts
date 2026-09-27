import { defineConfig } from "prisma/config";
import { resolveMigrationTarget } from "./scripts/db-urls.mjs";
import { loadEnv } from "./scripts/load-env.mjs";

loadEnv();

// Migrations/DDL use the DIRECT (unpooled) Neon connection: DIRECT_URL, then
// DATABASE_URL_UNPOOLED, then DATABASE_URL with "-pooler" removed from its
// host. scripts/db-urls.mjs explains why the pooler can't be used.
const migration = resolveMigrationTarget();
if (migration.mismatch) {
  // Refuse only where it matters. With no URL, every command that connects to
  // a database (migrate *, db *, studio) stops with Prisma's "datasource.url is
  // required" error, while generate, validate and format keep working, so
  // `npm install` and the Vercel build's generate step aren't blocked by it.
  console.error(
    `\nprisma.config.ts: ${migration.mismatch}\n` +
      "No datasource URL was passed to Prisma, so commands that connect to a database will not run.\n",
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Run with `npx prisma db seed` (Prisma 7 no longer auto-seeds).
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: migration.mismatch ? undefined : migration.url,
  },
});
