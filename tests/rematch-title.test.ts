import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

type Row = Record<string, unknown>;
type TmdbStub = {
  calls: Array<{ kind: string; options: unknown }>;
  tvId: number;
  episodes: Array<{ id: number; episode_number: number; name: string; air_date: string }>;
  /** Fields merged over the stubbed TV detail. */
  tv?: Row;
  /** When set, getMovie returns these fields instead of throwing. */
  movie?: Row;
  /** Season numbers whose fetch rejects. */
  failSeasons?: number[];
};

Object.assign(globalThis, {
  __CELLULOID_C1_DB__: {},
  __CELLULOID_C1_TMDB__: {
    calls: [],
    tvId: 200,
    episodes: [],
  } satisfies TmdbStub,
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
    return stub("export const prisma = globalThis.__CELLULOID_C1_DB__;");
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return stub("export async function getSession() { return { user: { id: 'owner-1' } }; }");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath() {}");
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "const state = globalThis.__CELLULOID_C1_TMDB__;" +
      "export async function getMovie(id, options) { state.calls.push({kind:'movie', options}); if (!state.movie) throw new Error('unused movie'); return {id,...state.movie}; }" +
      "export async function getTv(id, options) { state.calls.push({kind:'tv', options}); return {id,name:'Series',original_name:'',overview:'',first_air_date:'2012-01-01',poster_path:null,backdrop_path:null,original_language:'en',vote_average:8,episode_run_time:[45],genres:[],number_of_seasons:1,seasons:[{season_number:1}],...state.tv}; }" +
      "export async function getSeason(_id, n, options) { state.calls.push({kind:'season', options}); if (state.failSeasons?.includes(n)) throw new Error('season unavailable'); return {id:500+n,season_number:n,name:'Season 1',overview:'',air_date:'2012-01-01',poster_path:null,episodes:state.episodes.map(e=>({...e,season_number:n,overview:'',runtime:45,still_path:null,vote_average:0}))}; }"
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { addFromTmdb, rematchTitle } = await import("../src/lib/actions");

function createRematchDb(options: {
  currentTmdbId: number;
  status: "WATCHLIST" | "WATCHING" | "WATCHED" | "ON_HOLD" | "DROPPED";
  /** Extra Title columns, such as the sync fields a re-match must replace. */
  title?: Row;
  episodes?: Array<{
    tmdbId: number;
    episodeNumber: number;
    name: string;
    watched: boolean;
    withdrawnAt?: Date | null;
    eventId?: string;
  }>;
}) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  const title: Row = {
    id: "title-1",
    userId: "owner-1",
    tmdbId: options.currentTmdbId,
    mediaType: "TV",
    status: options.status,
    watchedAt: options.status === "WATCHED" ? new Date("2026-02-01T00:00:00Z") : null,
    createdAt,
    totalEpisodes: options.episodes?.length ?? 0,
    watchedEpisodes: options.episodes?.filter((episode) => episode.watched).length ?? 0,
    ...options.title,
  };
  let season: Row | null = {
    id: "season-old",
    titleId: title.id,
    seasonNumber: 1,
    tmdbId: 501,
    name: "Season 1",
    overview: null,
    airDate: new Date("2012-01-01T00:00:00Z"),
    posterPath: null,
  };
  let episodeSequence = 0;
  let episodes: Row[] = (options.episodes ?? []).map((episode) => ({
    id: `old-${episode.tmdbId}`,
    seasonId: season?.id,
    tmdbId: episode.tmdbId,
    episodeNumber: episode.episodeNumber,
    name: episode.name,
    overview: null,
    airDate: new Date("2012-01-01T00:00:00Z"),
    runtime: 45,
    stillPath: null,
    watched: episode.watched,
    watchedAt: episode.watched ? new Date("2026-02-01T00:00:00Z") : null,
    withdrawnAt: episode.withdrawnAt ?? null,
    discoveredAt: createdAt,
    eventId: episode.eventId,
  }));
  const events = (options.episodes ?? []).flatMap((episode) =>
    episode.eventId
      ? [{ id: episode.eventId, titleId: title.id, episodeId: `old-${episode.tmdbId}` }]
      : [],
  );
  const createdRows: Row[] = [];

  const db = {
    title: {
      findFirst: async ({ where }: { where: Row }) => {
        if (where.NOT) return null;
        return where.id === title.id && where.userId === title.userId ? { id: title.id } : null;
      },
    },
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) =>
          values[0] === title.id && values[1] === title.userId ? [{ ...title }] : [],
        season: {
          deleteMany: async () => {
            episodes = [];
            season = null;
            for (const event of events) event.episodeId = null as never;
          },
          create: async ({ data }: { data: Row }) => {
            season = { id: "season-new", ...data };
            return season;
          },
        },
        episode: {
          findMany: async () =>
            episodes.map((episode) => ({
              ...episode,
              season: {
                seasonNumber: season?.seasonNumber,
                tmdbId: season?.tmdbId,
                name: season?.name,
                overview: season?.overview,
                airDate: season?.airDate,
                posterPath: season?.posterPath,
              },
              watchEvents: events
                .filter((event) => event.episodeId === episode.id)
                .map((event) => ({ id: event.id })),
            })),
          createMany: async ({ data }: { data: Row[] }) => {
            for (const row of data) {
              assert.ok(
                (row.episodeNumber as number) >= 0,
                "episodeNumber CHECK rejected a negative write",
              );
              assert.ok(
                row.withdrawnAt === null || row.withdrawnAt instanceof Date,
                "withdrawnAt must be null or a Date",
              );
              assert.equal(
                episodes.some(
                  (episode) => episode.episodeNumber === row.episodeNumber,
                ),
                false,
                "season/episodeNumber unique rejected a colliding write",
              );
              const stored = {
                id: `fresh-${++episodeSequence}`,
                watched: false,
                watchedAt: null,
                ...row,
              };
              episodes.push(stored);
              createdRows.push(stored);
            }
          },
          count: async ({ where }: { where: Row }) =>
            episodes.filter(
              (episode) =>
                (where.watched === undefined || episode.watched === where.watched) &&
                (where.withdrawnAt !== null || episode.withdrawnAt === null),
            ).length,
        },
        title: {
          update: async ({ data }: { data: Row }) => {
            Object.assign(title, data);
          },
        },
        watchEvent: {
          findFirst: async () => null,
          create: async () => undefined,
          updateMany: async ({ where, data }: { where: { id: { in: string[] } }; data: Row }) => {
            for (const event of events) {
              if (where.id.in.includes(event.id)) Object.assign(event, data);
            }
          },
        },
      }),
  };

  return {
    db,
    title,
    events,
    createdRows,
    episodes: () => episodes,
  };
}

beforeEach(() => {
  Object.assign(globalThis.__CELLULOID_C1_TMDB__, {
    tv: {},
    movie: undefined,
    failSeasons: [],
  });
});

describe("rematchTitle TMDB identity", { concurrency: false }, () => {
  it("freshly rematches an old catalogue without badging it and re-derives status", async () => {
    const state = createRematchDb({ currentTmdbId: 100, status: "WATCHED" });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__ as TmdbStub;
    tmdb.calls.length = 0;
    tmdb.episodes = [1, 2, 3].map((episodeNumber) => ({
      id: 2000 + episodeNumber,
      episode_number: episodeNumber,
      name: `Episode ${episodeNumber}`,
      air_date: `2012-01-0${episodeNumber}`,
    }));
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.status, "WATCHLIST");
    assert.equal(state.title.totalEpisodes, 3);
    assert.equal(state.title.watchedEpisodes, 0);
    assert.ok(
      state.createdRows.every(
        (episode) =>
          (episode.discoveredAt as Date).getTime() <=
          (state.title.createdAt as Date).getTime(),
      ),
    );
    assert.ok(state.createdRows.every((episode) => episode.withdrawnAt === null));
    assert.deepEqual(
      tmdb.calls.map((call) => call.options),
      [{ fresh: true }, { fresh: true }],
    );
  });

  it("preserves a renumbered episode tick and relinks its event by TMDB id", async () => {
    const state = createRematchDb({
      currentTmdbId: 400,
      status: "WATCHING",
      episodes: [
        { tmdbId: 4001, episodeNumber: 1, name: "Pilot", watched: true, eventId: "event-pilot" },
        { tmdbId: 4002, episodeNumber: 2, name: "Second", watched: false },
      ],
    });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__ as TmdbStub;
    tmdb.calls.length = 0;
    tmdb.episodes = [
      { id: 4000, episode_number: 1, name: "Special", air_date: "2012-01-01" },
      { id: 4001, episode_number: 2, name: "Pilot", air_date: "2012-01-02" },
      { id: 4002, episode_number: 3, name: "Second", air_date: "2012-01-03" },
    ];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 400, "tv"), { ok: true });
    const pilot = state.episodes().find((episode) => episode.tmdbId === 4001);
    assert.equal(pilot?.episodeNumber, 2);
    assert.equal(pilot?.watched, true);
    assert.equal(state.events[0].episodeId, pilot?.id);
    assert.equal(state.title.status, "WATCHING");
  });

  it("recreates an absent watched episode with its withdrawal history", async () => {
    const withdrawnAt = new Date("2026-08-15T00:00:00Z");
    const state = createRematchDb({
      currentTmdbId: 400,
      status: "WATCHING",
      episodes: [
        {
          tmdbId: 4002,
          episodeNumber: 2,
          name: "Withdrawn",
          watched: true,
          withdrawnAt,
          eventId: "event-withdrawn",
        },
      ],
    });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__ as TmdbStub;
    tmdb.calls.length = 0;
    tmdb.episodes = [
      { id: 4001, episode_number: 1, name: "Pilot", air_date: "2012-01-01" },
    ];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 400, "tv"), { ok: true });
    const withdrawn = state.episodes().find((episode) => episode.tmdbId === 4002);
    assert.equal(withdrawn?.episodeNumber, 2);
    assert.equal(
      (withdrawn?.airDate as Date | undefined)?.toISOString(),
      "2012-01-01T00:00:00.000Z",
    );
    assert.equal(withdrawn?.withdrawnAt, withdrawnAt);
    assert.equal(withdrawn?.watched, true);
    assert.equal(state.events[0].episodeId, withdrawn?.id);
    assert.equal(state.title.totalEpisodes, 1);
    assert.equal(state.title.watchedEpisodes, 0);
  });
});

/** Sync fields a wrong "Ended" match leaves behind, including a stale failure. */
const STALE_SYNC_FIELDS: Row = {
  tmdbStatus: "Ended",
  nextEpisodeAirDate: new Date("2020-05-01T00:00:00Z"),
  metadataSyncedAt: new Date("2026-03-01T00:00:00Z"),
  metadataSyncState: "FAILED",
  metadataLastError: "TMDB 404 on /tv/100",
  streamProviderIds: [8, 337],
  providersRegion: "GB",
  providersSyncedAt: new Date("2026-03-01T00:00:00Z"),
};

const MOVIE_DETAIL: Row = {
  title: "Film",
  original_title: "",
  overview: "",
  release_date: "2020-01-01",
  poster_path: null,
  backdrop_path: null,
  original_language: "en",
  vote_average: 7,
  runtime: 100,
  genres: [],
};

describe("rematchTitle sync fields", { concurrency: false }, () => {
  it("takes the new show's lifecycle and drops the old entry's sync state", async () => {
    const state = createRematchDb({
      currentTmdbId: 100,
      status: "WATCHED",
      title: STALE_SYNC_FIELDS,
    });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = {
      status: "Returning Series",
      next_episode_to_air: { air_date: "2999-01-01" },
    };
    tmdb.episodes = [
      { id: 2001, episode_number: 1, name: "Pilot", air_date: "2012-01-01" },
    ];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);
    const before = Date.now();

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.tmdbStatus, "Returning Series");
    assert.equal(
      (state.title.nextEpisodeAirDate as Date).toISOString(),
      "2999-01-01T00:00:00.000Z",
    );
    assert.equal(state.title.metadataSyncState, "OK");
    assert.equal(state.title.metadataLastError, null);
    assert.ok((state.title.metadataSyncedAt as Date).getTime() >= before);
    assert.deepEqual(state.title.streamProviderIds, []);
    assert.equal(state.title.providersRegion, null);
    assert.equal(state.title.providersSyncedAt, null);
    // Different series: the ticks are gone, so the show re-enters the queue.
    assert.equal(state.title.status, "WATCHLIST");
  });

  it("keeps the provider cache on a same-series refresh and derives the next date", async () => {
    const state = createRematchDb({
      currentTmdbId: 200,
      status: "WATCHING",
      title: STALE_SYNC_FIELDS,
    });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = { status: "Returning Series", next_episode_to_air: null };
    tmdb.episodes = [
      { id: 2001, episode_number: 1, name: "Pilot", air_date: "2012-01-01" },
      { id: 2002, episode_number: 2, name: "Next", air_date: "2999-02-01" },
    ];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.tmdbStatus, "Returning Series");
    assert.equal(
      (state.title.nextEpisodeAirDate as Date).toISOString(),
      "2999-02-01T00:00:00.000Z",
    );
    assert.equal(state.title.metadataSyncState, "OK");
    assert.equal(state.title.metadataLastError, null);
    assert.deepEqual(state.title.streamProviderIds, [8, 337]);
    assert.equal(state.title.providersRegion, "GB");
  });

  it("clears TV lifecycle and sync state when a show is re-matched to a movie", async () => {
    const state = createRematchDb({
      currentTmdbId: 100,
      status: "WATCHED",
      title: STALE_SYNC_FIELDS,
    });
    globalThis.__CELLULOID_C1_TMDB__.movie = MOVIE_DETAIL;
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 300, "movie"), { ok: true });
    assert.equal(state.title.mediaType, "MOVIE");
    assert.equal(state.title.tmdbStatus, null);
    assert.equal(state.title.nextEpisodeAirDate, null);
    assert.equal(state.title.metadataSyncedAt, null);
    assert.equal(state.title.metadataSyncState, null);
    assert.equal(state.title.metadataLastError, null);
    assert.deepEqual(state.title.streamProviderIds, []);
    assert.equal(state.title.providersSyncedAt, null);
  });

  it("keeps the provider cache when a movie refreshes its own entry", async () => {
    const state = createRematchDb({
      currentTmdbId: 300,
      status: "WATCHED",
      title: { ...STALE_SYNC_FIELDS, mediaType: "MOVIE" },
    });
    globalThis.__CELLULOID_C1_TMDB__.movie = MOVIE_DETAIL;
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 300, "movie"), { ok: true });
    assert.equal(state.title.metadataSyncState, null);
    assert.deepEqual(state.title.streamProviderIds, [8, 337]);
    assert.equal(state.title.providersRegion, "GB");
  });
});

describe("addFromTmdb sync fields", { concurrency: false }, () => {
  function createAddDb() {
    const created: Row = {};
    const db = {
      title: { findUnique: async () => null },
      $transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          title: {
            create: async ({ data }: { data: Row }) =>
              Object.assign(
                created,
                { id: "title-new", createdAt: new Date("2026-09-01T00:00:00Z") },
                data,
              ),
            update: async ({ data }: { data: Row }) => Object.assign(created, data),
          },
          season: {
            create: async ({ data }: { data: Row }) => ({
              id: `season-${String(data.seasonNumber)}`,
              ...data,
            }),
          },
          episode: {
            createMany: async () => undefined,
            count: async () => 0,
          },
        }),
    };
    return { db, created };
  }

  const TWO_SEASONS: Row = {
    status: "Returning Series",
    next_episode_to_air: { air_date: "2999-01-01" },
    number_of_seasons: 2,
    seasons: [{ season_number: 1 }, { season_number: 2 }],
  };

  it("records lifecycle and marks a complete add as synced", async () => {
    const state = createAddDb();
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = TWO_SEASONS;
    tmdb.episodes = [];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await addFromTmdb(200, "tv"), { id: "title-new" });
    assert.equal(state.created.tmdbStatus, "Returning Series");
    assert.equal(
      (state.created.nextEpisodeAirDate as Date).toISOString(),
      "2999-01-01T00:00:00.000Z",
    );
    assert.equal(state.created.metadataSyncState, "OK");
    assert.ok(state.created.metadataSyncedAt instanceof Date);
  });

  it("leaves a partial add unsynced so the next run takes it first", async () => {
    const state = createAddDb();
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = TWO_SEASONS;
    tmdb.episodes = [];
    tmdb.failSeasons = [2];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    const result = await addFromTmdb(200, "tv");
    assert.equal(result.id, "title-new");
    assert.ok(result.warning);
    assert.equal(state.created.tmdbStatus, "Returning Series");
    assert.equal("metadataSyncedAt" in state.created, false);
    assert.equal("metadataSyncState" in state.created, false);
  });
});

declare global {
  var __CELLULOID_C1_DB__: Record<string, unknown>;
  var __CELLULOID_C1_TMDB__: TmdbStub;
}
