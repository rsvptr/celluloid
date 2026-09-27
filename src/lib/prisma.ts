import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { PRISMA_POOL_MAX } from "@/lib/db-pool";

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

/** node-postgres pool settings for the runtime client. */
export function poolConfig(
  url: string | undefined,
): PoolConfig & { enableChannelBinding: boolean } {
  return {
    connectionString: url,
    // Bounds how many client connections each serverless instance opens to
    // Neon's pooler, which multiplexes them onto Postgres connections.
    max: PRISMA_POOL_MAX,
    // pg otherwise waits forever, both to connect and for a free pool slot,
    // and ignores a connect_timeout in the URL (NE-04). 15 s leaves room for a
    // Neon compute waking from scale-to-zero.
    connectionTimeoutMillis: 15_000,
    // pg ignores channel_binding=require in the URL (NE-10). This opts in to
    // SCRAM-SHA-256-PLUS whenever the server offers it. pg falls back to plain
    // SCRAM-SHA-256 when it isn't offered, so it can't enforce binding the way
    // libpq's channel_binding=require does. @types/pg doesn't declare the
    // option, hence the widened type.
    enableChannelBinding: true,
  };
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
  const adapter = new PrismaPg(poolConfig(url));
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
