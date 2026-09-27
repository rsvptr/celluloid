import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

// scripts/db-check.mjs's queries on in-memory Postgres (PGlite) with every
// migration applied, through the generated client and the pg driver adapter.

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");
const { scan } = await import("../scripts/db-check.mjs");

const db = await PGlite.create();
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter((entry) => /^\d/.test(entry)).sort()) {
  await db.exec(readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"));
}
// One connection: PGlite runs one session at a time.
const server = new PGLiteSocketServer({ db, port: 0 });
await server.start();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
    max: 1,
  }),
});

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

await prisma.user.create({ data: { id: "owner", name: "Owner", email: "owner@example.test" } });

/** A show with one active and one withdrawn episode, both watched. */
async function seedShow(tmdbId: number, watchedEpisodes: number) {
  const title = await prisma.title.create({
    data: { userId: "owner", tmdbId, mediaType: "TV", name: `Show ${tmdbId}`, status: "WATCHING", watchedEpisodes },
  });
  const season = await prisma.season.create({ data: { titleId: title.id, seasonNumber: 1 } });
  const watchedAt = new Date("2026-02-07T20:00:00Z");
  await prisma.episode.create({ data: { seasonId: season.id, episodeNumber: 1, watched: true, watchedAt } });
  await prisma.episode.create({
    data: {
      seasonId: season.id,
      episodeNumber: 2,
      watched: true,
      watchedAt,
      withdrawnAt: new Date("2026-03-01T00:00:00Z"),
    },
  });
  return title.id;
}

describe("db-check counter drift", () => {
  it("counts active episodes only, as the app does", async () => {
    await seedShow(100, 1);
    const drifted = await seedShow(200, 2);

    const { counterDrift } = await scan(prisma);
    assert.deepEqual(
      counterDrift.map(({ id, counter, actual }: { id: string; counter: number; actual: bigint }) => ({
        id,
        counter,
        actual: Number(actual),
      })),
      [{ id: drifted, counter: 2, actual: 1 }],
    );
  });
});
