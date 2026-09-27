import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { PRISMA_POOL_MAX } from "../src/lib/db-pool";
import { poolConfig } from "../src/lib/prisma";

// Nothing here opens a socket: building a pg.Pool or pg.Client doesn't connect.
const TEST_URL = "postgresql://u:pw@127.0.0.1:1/celluloid";

describe("runtime pool configuration", () => {
  it("bounds connects and checkouts, sizes the pool, and opts in to channel binding", () => {
    assert.deepEqual(poolConfig(TEST_URL), {
      connectionString: TEST_URL,
      max: PRISMA_POOL_MAX,
      connectionTimeoutMillis: 15_000,
      enableChannelBinding: true,
    });
  });

  it("reaches pg's pool and every client it creates through the Prisma adapter", async () => {
    const adapter = await new PrismaPg(poolConfig(TEST_URL)).connect();
    try {
      const pool = adapter.underlyingDriver() as pg.Pool;
      assert.ok(pool instanceof pg.Pool);
      assert.equal(pool.options.max, PRISMA_POOL_MAX);
      // pg-pool times out waiting checkouts with this, not just new connects.
      assert.equal(pool.options.connectionTimeoutMillis, 15_000);
      // pg-pool constructs clients from its options, which is how the flag
      // (read only from config, never from the URL) reaches SASL.
      const client = new pg.Client(pool.options) as pg.Client & { enableChannelBinding: boolean };
      assert.equal(client.enableChannelBinding, true);
    } finally {
      await adapter.dispose();
    }
  });
});
