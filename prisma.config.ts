import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // Run with `npx prisma db seed` (Prisma 7 no longer auto-seeds).
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Migrations/DDL use the DIRECT (unpooled) Neon connection.
    // Falls back to DATABASE_URL if a separate direct URL isn't provided.
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL,
  },
});
