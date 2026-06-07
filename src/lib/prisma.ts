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

function createPrisma() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrisma();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
