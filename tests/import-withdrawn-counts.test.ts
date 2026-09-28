import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { after, describe, it } from "node:test";

// PR-11, end to end: the real staged import commit and legacy import on
// in-memory Postgres (PGlite) with every migration, so the migration-owned
// CHECK "watchedEpisodes <= totalEpisodes" is live. A withdrawn episode stays
// watched, and the import recounts used to count it, so an existing show
// imported as watched could fail that CHECK. Only TMDB, the session and
// next/cache are stubbed.

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

/** Legacy-import search results, by row name. */
const searchResults = new Map<string, number>();

Object.assign(globalThis, {
  __CELLULOID_IMPORT_COUNTS_PRISMA__: prisma,
  __CELLULOID_IMPORT_COUNTS_SEARCH__: searchResults,
});

// TMDB lists season 1 as episodes 1 to 3 for every show here.
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
    return stub("export const prisma = globalThis.__CELLULOID_IMPORT_COUNTS_PRISMA__;");
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return stub("export async function getSession() { return { user: { id: 'owner' } }; }");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath() {}");
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "export const MAX_APPENDED_SEASONS = 20;" +
      "export async function getMovie() { throw new Error('unused'); }" +
      "export async function findByImdbId() { throw new Error('unused'); }" +
      "export async function findTvByTvdbId() { throw new Error('unused'); }" +
      "export async function searchByType(_kind, name) { const id = globalThis.__CELLULOID_IMPORT_COUNTS_SEARCH__.get(name); return id ? [{ id, media_type: 'tv', name, original_name: name, first_air_date: '2012-01-01', poster_path: null, original_language: 'en' }] : []; }" +
      "export async function getTv(id) { return { id, name: 'Show', original_name: '', overview: '', first_air_date: '2012-01-01', poster_path: null, backdrop_path: null, original_language: 'en', vote_average: 8, episode_run_time: [], genres: [], number_of_seasons: 1, status: 'Returning Series', next_episode_to_air: null, seasons: [{ id: 701, season_number: 1 }] }; }" +
      "export async function getSeasons(_id, seasons) { return seasons.map(({ id, season_number: n }) => ({ n, sd: { id, season_number: n, name: 'Season 1', overview: '', air_date: '2012-01-01', poster_path: null, episodes: [1, 2, 3].map((e) => ({ id: 9000 + e, episode_number: e, season_number: n, name: 'E' + e, overview: '', air_date: '2012-01-0' + e, runtime: 50, still_path: null, vote_average: 0 })) } })); }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { commitImportJobChunk } = await import("../src/lib/import-staging");
const { importParsedTitles } = await import("../src/lib/import/run-import");

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

await prisma.user.create({ data: { id: "owner", name: "Owner", email: "owner@example.test" } });

/**
 * A show on its WATCHLIST default with TMDB's episodes 1 to 3, unwatched (or
 * episode 1 watched), and optionally a legacy S1E7 (no TMDB id) that TMDB
 * has withdrawn: watched, as every withdrawn row is, with a watch event.
 */
async function seedShow(
  tmdbId: number,
  opts: { withdrawn?: boolean; firstWatched?: boolean; trashed?: boolean } = {},
) {
  const title = await prisma.title.create({
    data: {
      userId: "owner",
      tmdbId,
      mediaType: "TV",
      name: "Show",
      status: opts.firstWatched ? "WATCHING" : "WATCHLIST",
      totalEpisodes: 3,
      watchedEpisodes: opts.firstWatched ? 1 : 0,
      deletedAt: opts.trashed ? new Date("2026-09-01T00:00:00Z") : null,
    },
  });
  const season = await prisma.season.create({
    data: { titleId: title.id, seasonNumber: 1, tmdbId: 701 },
  });
  await prisma.episode.createMany({
    data: [1, 2, 3].map((n) => ({
      seasonId: season.id,
      tmdbId: 9000 + n,
      episodeNumber: n,
      name: `E${n}`,
      overview: "",
      airDate: new Date(`2012-01-0${n}T00:00:00Z`),
      runtime: 50,
      watched: opts.firstWatched === true && n === 1,
      watchedAt: opts.firstWatched === true && n === 1 ? new Date("2026-01-01T00:00:00Z") : null,
    })),
  });
  if (!opts.withdrawn) return { titleId: title.id, eventId: null };
  const legacy = await prisma.episode.create({
    data: {
      seasonId: season.id,
      tmdbId: null,
      episodeNumber: 7,
      airDate: new Date("2012-02-01T00:00:00Z"),
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

/** A review-ready job with one "Watched" row matched to `tmdbId`. */
async function stageWatchedRow(
  tmdbId: number,
  item: { action: "CREATE" | "UPDATE" | "FAILED"; titleId?: string; attempts?: number },
) {
  const job = await prisma.importJob.create({
    data: { userId: "owner", filename: "library.csv", status: "READY_FOR_REVIEW" },
  });
  const staged = await prisma.importItem.create({
    data: {
      jobId: job.id,
      rowNumber: 1,
      raw: {},
      normalized: {
        parsed: {
          source: "upload",
          mediaType: "tv",
          name: "Show",
          releaseDateText: null,
          releaseDate: null,
          status: "WATCHED",
          languageHint: null,
        },
        proposed: { tmdbId, mediaType: "tv", name: "Show", year: "2012", posterPath: null },
      },
      proposedTmdbId: tmdbId,
      proposedMediaType: "TV",
      matchScore: 1,
      action: item.action,
      titleId: item.titleId ?? null,
      attempts: item.attempts ?? 0,
      errorCode: item.action === "FAILED" ? "IMPORT_WRITE_FAILED" : null,
    },
  });
  return { jobId: job.id, itemId: staged.id };
}

/** The stored counters next to a recount of the title's episode rows. */
async function counts(titleId: string) {
  const title = await prisma.title.findUniqueOrThrow({
    where: { id: titleId },
    select: { status: true, watchedEpisodes: true, totalEpisodes: true, deletedAt: true },
  });
  const [activeTotal, activeWatched, withdrawn] = await Promise.all([
    prisma.episode.count({ where: { season: { titleId }, withdrawnAt: null } }),
    prisma.episode.count({ where: { season: { titleId }, withdrawnAt: null, watched: true } }),
    prisma.episode.count({ where: { season: { titleId }, withdrawnAt: { not: null } } }),
  ]);
  return { ...title, activeTotal, activeWatched, withdrawn };
}

describe("imports count only active episodes (PR-11)", { concurrency: false }, () => {
  it("has the CHECK these recounts used to break", async () => {
    const { titleId } = await seedShow(100, { withdrawn: true });
    // What the old recount wrote for this show: 3 active + 1 withdrawn watched.
    // In a transaction, as the imports write it: PGlite's socket server drops
    // the connection after a failed statement outside one.
    await assert.rejects(
      prisma.$transaction((tx) =>
        tx.title.update({ where: { id: titleId }, data: { watchedEpisodes: 4 } }),
      ),
      /Title_watched_le_total_check/,
    );
  });

  it("commits a watched re-import of a show with a withdrawn episode", async () => {
    const { titleId, eventId } = await seedShow(200, { withdrawn: true });
    const { jobId, itemId } = await stageWatchedRow(200, { action: "UPDATE" });

    const view = await commitImportJobChunk("owner", jobId);

    const item = await prisma.importItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(item.action, "UPDATE");
    assert.equal(item.errorCode, null);
    assert.equal(item.titleId, titleId);
    assert.equal(view?.status, "COMPLETED");
    assert.deepEqual(await counts(titleId), {
      status: "WATCHED",
      watchedEpisodes: 3,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 3,
      withdrawn: 1,
    });
    // The refresh kept the withdrawn legacy row, and its history, on its own row.
    const event = await prisma.watchEvent.findUniqueOrThrow({
      where: { id: eventId! },
      select: { episode: { select: { tmdbId: true, episodeNumber: true, watched: true, withdrawnAt: true } } },
    });
    assert.equal(event.episode?.tmdbId, null);
    assert.equal(event.episode?.episodeNumber, 7);
    assert.equal(event.episode?.watched, true);
    assert.ok(event.episode?.withdrawnAt instanceof Date);
  });

  it("commits one restored from Trash", async () => {
    const { titleId } = await seedShow(300, { withdrawn: true, trashed: true });
    const { jobId, itemId } = await stageWatchedRow(300, { action: "UPDATE" });

    await commitImportJobChunk("owner", jobId);

    const item = await prisma.importItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(item.action, "UPDATE");
    assert.equal(item.errorCode, null);
    assert.equal(item.warning, "Restored from Trash.");
    assert.deepEqual(await counts(titleId), {
      status: "WATCHED",
      watchedEpisodes: 3,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 3,
      withdrawn: 1,
    });
  });

  it("retries the status seed on a created show that has a withdrawn episode", async () => {
    const { titleId } = await seedShow(400, { withdrawn: true });
    const { jobId, itemId } = await stageWatchedRow(400, {
      action: "FAILED",
      titleId,
      attempts: 1,
    });

    await commitImportJobChunk("owner", jobId);

    const item = await prisma.importItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(item.action, "CREATE");
    assert.equal(item.errorCode, null);
    assert.equal(item.attempts, 2);
    assert.deepEqual(await counts(titleId), {
      status: "WATCHED",
      watchedEpisodes: 3,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 3,
      withdrawn: 1,
    });
  });

  // P7X-2: the seed marked every aired episode watched with watchedAt null,
  // wiping the date on episodes the owner had already watched, and on the
  // withdrawn row, which is always watched.
  it("keeps the dates of episodes already watched when it retries the seed", async () => {
    const { titleId } = await seedShow(450, { withdrawn: true, firstWatched: true });
    const { jobId, itemId } = await stageWatchedRow(450, {
      action: "FAILED",
      titleId,
      attempts: 1,
    });

    await commitImportJobChunk("owner", jobId);

    const item = await prisma.importItem.findUniqueOrThrow({ where: { id: itemId } });
    assert.equal(item.action, "CREATE");
    assert.equal(item.errorCode, null);
    const episodes = await prisma.episode.findMany({
      where: { season: { titleId } },
      orderBy: { episodeNumber: "asc" },
      select: { episodeNumber: true, watched: true, watchedAt: true },
    });
    assert.deepEqual(
      episodes.map((e) => [e.episodeNumber, e.watched, e.watchedAt?.toISOString() ?? null]),
      [
        [1, true, "2026-01-01T00:00:00.000Z"],
        [2, true, null],
        [3, true, null],
        [7, true, "2026-02-07T20:00:00.000Z"],
      ],
    );
    assert.equal((await counts(titleId)).watchedEpisodes, 3);
  });

  it("leaves withdrawn episodes out of the legacy import's counters", async () => {
    const { titleId } = await seedShow(500, { withdrawn: true, firstWatched: true });
    searchResults.set("Show 500", 500);

    const result = await importParsedTitles({
      userId: "owner",
      parsed: [
        {
          source: "TV Shows",
          mediaType: "tv",
          name: "Show 500",
          releaseDateText: null,
          releaseDate: null,
          status: "PARTIALLY_WATCHED",
          languageHint: null,
        },
      ],
    });

    assert.deepEqual(result.failed, []);
    assert.equal(result.updated, 1);
    assert.deepEqual(await counts(titleId), {
      status: "WATCHING",
      watchedEpisodes: 1,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 1,
      withdrawn: 1,
    });
  });

  it("counts shows without withdrawn episodes as before", async () => {
    const legacy = await seedShow(600, { firstWatched: true });
    searchResults.set("Show 600", 600);
    await importParsedTitles({
      userId: "owner",
      parsed: [
        {
          source: "TV Shows",
          mediaType: "tv",
          name: "Show 600",
          releaseDateText: null,
          releaseDate: null,
          status: "PARTIALLY_WATCHED",
          languageHint: null,
        },
      ],
    });
    assert.deepEqual(await counts(legacy.titleId), {
      status: "WATCHING",
      watchedEpisodes: 1,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 1,
      withdrawn: 0,
    });

    const staged = await seedShow(700);
    const { jobId } = await stageWatchedRow(700, { action: "UPDATE" });
    await commitImportJobChunk("owner", jobId);
    assert.deepEqual(await counts(staged.titleId), {
      status: "WATCHED",
      watchedEpisodes: 3,
      totalEpisodes: 3,
      deletedAt: null,
      activeTotal: 3,
      activeWatched: 3,
      withdrawn: 0,
    });
  });
});
