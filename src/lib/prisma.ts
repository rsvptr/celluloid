import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Single PrismaClient instance backed by the node-postgres driver adapter
 * (Prisma 7 requires a driver adapter). Uses the Neon POOLED connection string
 * at runtime. A globalThis singleton prevents connection exhaustion during
 * Next.js dev hot-reloads.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

function warnIfNotPooled(url: string) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  if (!host.includes("-pooler")) {
    // Serverless instances opening direct (non-pooled) Postgres connections
    // can exhaust the database's connection limit under concurrent load.
    console.warn(
      'DATABASE_URL does not look like a pooled connection (host has no "-pooler"); serverless instances opening direct Postgres connections can exhaust the connection limit.',
    );
  }
}

function createPrisma() {
  const url = process.env.DATABASE_URL;
  // Only fail fast in production: code paths that skip env.ts's validation
  // (the cron route) would otherwise hit a raw pg ECONNREFUSED-to-localhost
  // instead of a message naming the actual problem. Outside production this
  // must stay import-safe — many modules import prisma.ts transitively
  // without ever issuing a query (tests, dev tooling), exactly like the
  // pre-existing `process.env.DATABASE_URL` behavior did.
  if (!url) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "DATABASE_URL is not set. Celluloid cannot connect to Postgres without it.",
      );
    }
  } else if (process.env.NODE_ENV === "production") {
    warnIfNotPooled(url);
  }
  // Explicit pool max: bounds how many direct connections each serverless
  // instance can open at once.
  const adapter = new PrismaPg({ connectionString: url, max: 5 });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
