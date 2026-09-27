/**
 * Connections each serverless instance's Prisma client holds to Neon's pooler.
 * Code that fans out interactive transactions stays below it, leaving a
 * connection for the instance's other requests. It lives apart from
 * `@/lib/prisma` so importing it never builds a client.
 */
export const PRISMA_POOL_MAX = 5;
