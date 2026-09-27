import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

type Row = Record<string, unknown>;
type TmdbStub = {
  calls: Array<{ kind: string; options: unknown; count?: number }>;
  tvId: number;
  episodes: Array<{
    id: number;
    episode_number: number;
    name: string;
    air_date: string;
    /** Defaults to 45 when left out. */
    runtime?: number | null;
  }>;
  /** Fields merged over the stubbed TV detail. */
  tv?: Row;
  /** When set, getMovie returns these fields instead of throwing. */
  movie?: Row;
  /** Season numbers whose request rejects, taking its whole chunk with it. */
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
      "export const MAX_APPENDED_SEASONS = 20;" +
      "export async function getSeasons(_id, seasons, options) { state.calls.push({kind:'seasons', options, count: seasons.length}); if (seasons.some(s=>state.failSeasons?.includes(s.season_number))) throw new Error('seasons unavailable'); return seasons.map(({season_number:n})=>({n,sd:{id:500+n,season_number:n,name:'Season '+n,overview:'',air_date:'2012-01-01',poster_path:null,episodes:state.episodes.map(e=>({...e,id:e.id+(n-1)*1000,season_number:n,overview:'',runtime:e.runtime===undefined?45:e.runtime,still_path:null,vote_average:0}))}})); }"
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
  let seasons: Row[] = [
    {
      id: "season-old",
      titleId: title.id,
      seasonNumber: 1,
      tmdbId: 501,
      name: "Season 1",
      overview: null,
      airDate: new Date("2012-01-01T00:00:00Z"),
      posterPath: null,
    },
  ];
  let episodeSequence = 0;
  let episodes: Row[] = (options.episodes ?? []).map((episode) => ({
    id: `old-${episode.tmdbId}`,
    seasonId: "season-old",
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
  /** Statements issued inside the transaction, by model method. */
  const statements: Record<string, number> = {};
  const tally = (name: string) => {
    statements[name] = (statements[name] ?? 0) + 1;
  };
  const seasonOf = (episode: Row) => seasons.find((row) => row.id === episode.seasonId);

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
            tally("season.deleteMany");
            episodes = [];
            seasons = [];
            for (const event of events) event.episodeId = null as never;
          },
          createManyAndReturn: async ({ data }: { data: Row[] }) => {
            tally("season.createManyAndReturn");
            const created = data.map((row) => {
              assert.equal(
                seasons.some((season) => season.seasonNumber === row.seasonNumber),
                false,
                "title/seasonNumber unique rejected a colliding write",
              );
              const season: Row = { id: `season-new-${String(row.seasonNumber)}`, ...row };
              seasons.push(season);
              return season;
            });
            return created.map(({ id, seasonNumber }) => ({ id, seasonNumber }));
          },
        },
        episode: {
          findMany: async () =>
            episodes.map((episode) => {
              const season = seasonOf(episode);
              return {
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
              };
            }),
          createMany: async ({ data }: { data: Row[] }) => {
            tally("episode.createMany");
            for (const row of data) {
              assert.ok(seasonOf(row), "episode written without a created season");
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
                  (episode) =>
                    episode.seasonId === row.seasonId &&
                    episode.episodeNumber === row.episodeNumber,
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
        // The relink UPDATE: one joined VALUES list of (eventId, episodeId)
        // pairs, then the title and owner the write is confined to. The text
        // is pinned because this fake applies the pairs by position: a wrong
        // join key or swapped columns would still "work" here while detaching
        // every event in Postgres.
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          tally("$executeRaw");
          assert.equal(
            strings.join("?").replace(/\s+/g, " ").trim(),
            'UPDATE "WatchEvent" AS w SET "episodeId" = v.episode_id ' +
              "FROM (VALUES ?) AS v(event_id, episode_id) " +
              'WHERE w.id = v.event_id AND w."titleId" = ? AND w."userId" = ?',
          );
          const [pairs, titleId, userId] = values as [
            { sql: string; values: string[] },
            string,
            string,
          ];
          assert.match(pairs.sql, /^\(\?::text, \?::text\)(,\(\?::text, \?::text\))*$/);
          assert.equal(titleId, title.id);
          assert.equal(userId, title.userId);
          let updated = 0;
          for (let index = 0; index < pairs.values.length; index += 2) {
            const event = events.find((row) => row.id === pairs.values[index]);
            if (!event) continue;
            event.episodeId = pairs.values[index + 1];
            updated++;
          }
          return updated;
        },
      }),
  };

  return {
    db,
    title,
    events,
    createdRows,
    statements,
    episodes: () => episodes,
    seasons: () => seasons,
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

describe("rematchTitle transaction shape", { concurrency: false }, () => {
  it("rebuilds a multi-season show and relinks its history in fixed statements", async () => {
    const state = createRematchDb({
      currentTmdbId: 400,
      status: "WATCHING",
      episodes: [1, 2, 3].map((n) => ({
        tmdbId: 4000 + n,
        episodeNumber: n,
        name: `Episode ${n}`,
        watched: true,
        eventId: `event-${n}`,
      })),
    });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = {
      number_of_seasons: 3,
      seasons: [{ season_number: 1 }, { season_number: 2 }, { season_number: 3 }],
    };
    tmdb.episodes = [1, 2, 3, 4].map((n) => ({
      id: 4000 + n,
      episode_number: n,
      name: `Episode ${n}`,
      air_date: "2012-01-01",
    }));
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 400, "tv"), { ok: true });
    assert.equal(state.seasons().length, 3);
    assert.equal(state.episodes().length, 12);
    assert.deepEqual(state.statements, {
      "season.deleteMany": 1,
      "season.createManyAndReturn": 1,
      "episode.createMany": 1,
      $executeRaw: 1,
    });
    for (const event of state.events) {
      const episode = state.episodes().find((row) => row.id === event.episodeId);
      assert.equal(episode?.tmdbId, 4000 + Number(event.id.slice(-1)));
      assert.equal(episode?.watched, true);
    }
    assert.equal(state.title.watchedEpisodes, 3);
  });

  it("recreates a season TMDB dropped so its watched episode keeps its history", async () => {
    const state = createRematchDb({
      currentTmdbId: 400,
      status: "WATCHING",
      episodes: [
        { tmdbId: 4001, episodeNumber: 1, name: "Pilot", watched: true, eventId: "event-1" },
      ],
    });
    state.seasons().push({
      id: "season-old-2",
      titleId: "title-1",
      seasonNumber: 2,
      tmdbId: 502,
      name: "Season 2",
      overview: null,
      airDate: new Date("2013-01-01T00:00:00Z"),
      posterPath: null,
    });
    state.episodes().push({
      id: "old-4200",
      seasonId: "season-old-2",
      tmdbId: 4200,
      episodeNumber: 1,
      name: "Dropped",
      overview: null,
      airDate: new Date("2013-01-01T00:00:00Z"),
      runtime: 45,
      stillPath: null,
      watched: true,
      watchedAt: new Date("2026-02-01T00:00:00Z"),
      withdrawnAt: null,
      discoveredAt: new Date("2026-01-01T00:00:00Z"),
    });
    state.events.push({ id: "event-dropped", titleId: "title-1", episodeId: "old-4200" });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.episodes = [{ id: 4001, episode_number: 1, name: "Pilot", air_date: "2012-01-01" }];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 400, "tv"), { ok: true });
    const placeholder = state.seasons().find((season) => season.seasonNumber === 2);
    assert.equal(placeholder?.tmdbId, 502);
    assert.equal(placeholder?.name, "Season 2");
    assert.equal(placeholder?.episodeCount, 0);
    const dropped = state.episodes().find((episode) => episode.tmdbId === 4200);
    assert.equal(dropped?.seasonId, placeholder?.id);
    assert.equal(dropped?.watched, true);
    assert.ok(dropped?.withdrawnAt instanceof Date);
    assert.equal(
      state.events.find((event) => event.id === "event-dropped")?.episodeId,
      dropped?.id,
    );
    assert.equal(state.statements["season.createManyAndReturn"], 2);
    assert.equal(state.statements["episode.createMany"], 2);
    assert.equal(state.statements.$executeRaw, 1);
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

describe("rematchTitle TV runtime", { concurrency: false }, () => {
  const episodesWithRuntimes = (...runtimes: Array<number | null>) =>
    runtimes.map((runtime, index) => ({
      id: 2001 + index,
      episode_number: index + 1,
      name: `Episode ${index + 1}`,
      air_date: "2012-01-01",
      runtime,
    }));

  it("keeps the stored runtime on a refresh when nothing states one", async () => {
    const state = createRematchDb({ currentTmdbId: 200, status: "WATCHING", title: { runtime: 50 } });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = { episode_run_time: [] };
    tmdb.episodes = episodesWithRuntimes(null, 0);
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.runtime, 50);
  });

  it("uses the episodes' median runtime when TMDB's episode_run_time is empty", async () => {
    const state = createRematchDb({ currentTmdbId: 200, status: "WATCHING", title: { runtime: 50 } });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = { episode_run_time: [] };
    tmdb.episodes = episodesWithRuntimes(58, 90, 60, null, 0);
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    // The median, so the 90-minute finale doesn't pull it to the mean (69).
    assert.equal(state.title.runtime, 60);
  });

  it("prefers the runtime TMDB states", async () => {
    const state = createRematchDb({ currentTmdbId: 200, status: "WATCHING", title: { runtime: 50 } });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = { episode_run_time: [42] };
    tmdb.episodes = episodesWithRuntimes(60);
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.runtime, 42);
  });

  it("drops the old entry's runtime on a re-match to a show that states none", async () => {
    const state = createRematchDb({ currentTmdbId: 100, status: "WATCHING", title: { runtime: 50 } });
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.tv = { episode_run_time: [] };
    tmdb.episodes = episodesWithRuntimes(null);
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    assert.deepEqual(await rematchTitle("title-1", 200, "tv"), { ok: true });
    assert.equal(state.title.runtime, null);
  });
});

describe("addFromTmdb sync fields", { concurrency: false }, () => {
  function createAddDb() {
    const created: Row = {};
    let seasonsWritten = 0;
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
            createManyAndReturn: async ({ data }: { data: Row[] }) => {
              seasonsWritten += data.length;
              return data.map((row) => ({
                id: `season-${String(row.seasonNumber)}`,
                seasonNumber: row.seasonNumber,
              }));
            },
          },
          episode: {
            createMany: async () => undefined,
            count: async () => 0,
          },
        }),
    };
    return { db, created, seasonsWritten: () => seasonsWritten };
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

  it("loads a long show 20 seasons per request and keeps the requests that loaded", async () => {
    const state = createAddDb();
    const tmdb = globalThis.__CELLULOID_C1_TMDB__;
    tmdb.calls.length = 0;
    tmdb.tv = {
      number_of_seasons: 25,
      seasons: Array.from({ length: 25 }, (_, i) => ({ id: 900 + i, season_number: i + 1 })),
    };
    tmdb.episodes = [];
    tmdb.failSeasons = [23];
    Object.assign(globalThis.__CELLULOID_C1_DB__, state.db);

    const result = await addFromTmdb(200, "tv");
    assert.ok(result.warning);
    assert.deepEqual(
      tmdb.calls.filter((call) => call.kind === "seasons").map((call) => call.count),
      [20, 5],
    );
    assert.equal(state.seasonsWritten(), 20);
    assert.equal(state.created.totalSeasons, 20);
  });
});

declare global {
  var __CELLULOID_C1_DB__: Record<string, unknown>;
  var __CELLULOID_C1_TMDB__: TmdbStub;
}
