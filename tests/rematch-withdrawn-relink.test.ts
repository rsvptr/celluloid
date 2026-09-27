import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { after, describe, it } from "node:test";

// review-p2-sync.md, issue 2, end to end: the real rematchTitle and
// setEpisodeWatched on in-memory Postgres (PGlite) with every migration, the
// generated Prisma client and the production pg driver adapter. Only TMDB, the
// session and next/cache are stubbed.

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

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

/** Season 1 as TMDB now lists it: which episode ids sit at which numbers. */
const tmdbSeason: Array<{ id: number; episode_number: number }> = [];

Object.assign(globalThis, {
  __CELLULOID_WITHDRAWN_PRISMA__: prisma,
  __CELLULOID_WITHDRAWN_TMDB_SEASON__: tmdbSeason,
});

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const stub = (source) => ({
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  });
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_WITHDRAWN_PRISMA__;");
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return stub("export async function getSession() { return { user: { id: 'owner' } }; }");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath() {}");
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "const season = globalThis.__CELLULOID_WITHDRAWN_TMDB_SEASON__;" +
      "export const MAX_APPENDED_SEASONS = 20;" +
      "export async function getMovie() { throw new Error('unused'); }" +
      "export async function getTv(id) { return { id, name: 'Show', original_name: '', overview: '', first_air_date: '2012-01-01', poster_path: null, backdrop_path: null, original_language: 'en', vote_average: 8, episode_run_time: [], genres: [], number_of_seasons: 1, status: 'Returning Series', next_episode_to_air: null, seasons: [{ id: 701, season_number: 1 }] }; }" +
      "export async function getSeasons(_id, seasons) { return seasons.map(({ id, season_number: n }) => ({ n, sd: { id, season_number: n, name: 'Season 1', overview: '', air_date: '2012-01-01', poster_path: null, episodes: season.map((e) => ({ ...e, season_number: n, name: 'E' + e.episode_number, overview: '', air_date: '2012-01-01', runtime: 50, still_path: null, vote_average: 0 })) } })); }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { rematchTitle, setEpisodeWatched } = await import("../src/lib/actions");

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

await prisma.user.create({ data: { id: "owner", name: "Owner", email: "owner@example.test" } });

/**
 * A show whose S1E7 is a legacy row (no TMDB id) that TMDB had already
 * withdrawn, watched, with one watch event on it.
 */
async function seedShow(tmdbId: number) {
  const title = await prisma.title.create({
    data: { userId: "owner", tmdbId, mediaType: "TV", name: "Show", status: "WATCHING" },
  });
  const season = await prisma.season.create({
    data: { titleId: title.id, seasonNumber: 1, tmdbId: 701 },
  });
  await prisma.episode.create({ data: { seasonId: season.id, tmdbId: 7001, episodeNumber: 1 } });
  const legacy = await prisma.episode.create({
    data: {
      seasonId: season.id,
      tmdbId: null,
      episodeNumber: 7,
      watched: true,
      watchedAt: new Date("2026-02-07T20:00:00Z"),
      withdrawnAt: new Date("2026-03-01T00:00:00Z"),
    },
  });
  const event = await prisma.watchEvent.create({
    data: {
      userId: "owner",
      titleId: title.id,
      episodeId: legacy.id,
      kind: "EPISODE_WATCHED",
      occurredAt: new Date("2026-02-07T20:00:00Z"),
    },
  });
  return { titleId: title.id, eventId: event.id };
}

async function eventEpisode(eventId: string) {
  const event = await prisma.watchEvent.findUniqueOrThrow({
    where: { id: eventId },
    select: { episode: { select: { tmdbId: true, episodeNumber: true, watched: true, withdrawnAt: true } } },
  });
  return event.episode;
}

describe("refreshing a show with an already-withdrawn legacy episode", { concurrency: false }, () => {
  it("keeps its history on the recreated withdrawn row when TMDB reuses its number", async () => {
    const { titleId, eventId } = await seedShow(700);
    // TMDB now has a new S1E7 of its own.
    tmdbSeason.splice(0, tmdbSeason.length, { id: 7001, episode_number: 1 }, { id: 7777, episode_number: 7 });

    assert.deepEqual(await rematchTitle(titleId, 700, "tv"), { ok: true });

    const kept = await eventEpisode(eventId);
    assert.equal(kept?.tmdbId, null);
    assert.equal(kept?.episodeNumber, 2_000_007);
    assert.equal(kept?.watched, true);
    assert.ok(kept?.withdrawnAt instanceof Date);

    const fresh = await prisma.episode.findFirstOrThrow({
      where: { season: { titleId }, tmdbId: 7777 },
      select: { id: true, episodeNumber: true, watched: true, watchEvents: { select: { id: true } } },
    });
    assert.equal(fresh.episodeNumber, 7);
    assert.equal(fresh.watched, false);
    assert.deepEqual(fresh.watchEvents, []);

    // Ticking and unticking the new episode used to delete the old history,
    // which had been moved onto it.
    assert.deepEqual(await setEpisodeWatched(fresh.id, true), {});
    assert.deepEqual(await setEpisodeWatched(fresh.id, false), {});
    assert.equal((await eventEpisode(eventId))?.episodeNumber, 2_000_007);
    assert.equal(await prisma.watchEvent.count({ where: { titleId } }), 1);
  });

  it("keeps it on the row recreated at its own number when that number is free", async () => {
    const { titleId, eventId } = await seedShow(800);
    tmdbSeason.splice(0, tmdbSeason.length, { id: 7001, episode_number: 1 });

    assert.deepEqual(await rematchTitle(titleId, 800, "tv"), { ok: true });

    const kept = await eventEpisode(eventId);
    assert.equal(kept?.episodeNumber, 7);
    assert.equal(kept?.tmdbId, null);
    assert.ok(kept?.withdrawnAt instanceof Date);
  });
});
