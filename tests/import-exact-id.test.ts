import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";
import type { ParsedTitle } from "../src/lib/import/parse-excel";

type Call = { fn: string; arg: unknown; signal: unknown };
type TmdbState = {
  calls: Call[];
  imdb: unknown[];
  tvdb: unknown[];
  tv: Record<number, unknown>;
  search: unknown[];
};

const tmdbState: TmdbState = { calls: [], imdb: [], tvdb: [], tv: {}, search: [] };
Object.assign(globalThis, { __CELLULOID_EXACT_ID_TMDB__: tmdbState });

// An in-memory import job, enough for staging and committing one to run.
type ItemRow = Record<string, unknown> & { id: string };
const db: { items: ItemRow[]; libraryTvIds: number[] } = { items: [], libraryTvIds: [] };
const fakePrisma = {
  importItem: {
    createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
      db.items = data.map((row, index) => ({
        id: `item-${index + 1}`,
        titleId: null,
        attempts: 0,
        ...row,
      }));
      return { count: data.length };
    },
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: { in: string[] } };
      data: Record<string, unknown>;
    }) => {
      const hit = db.items.filter((item) => where.id.in.includes(item.id));
      for (const item of hit) Object.assign(item, data);
      return { count: hit.length };
    },
  },
  importJob: {
    update: async () => ({}),
    updateMany: async () => ({ count: 1 }),
    findFirst: async () => ({
      id: "job-1",
      userId: "user-1",
      filename: "ratings.csv",
      status: "READY_FOR_REVIEW",
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
      committedAt: null,
      summary: null,
      items: db.items,
    }),
  },
  title: {
    findMany: async () => db.libraryTvIds.map((tmdbId) => ({ mediaType: "TV", tmdbId })),
  },
  $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes),
};
Object.assign(globalThis, { __CELLULOID_EXACT_ID_PRISMA__: fakePrisma });

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
    return stub("export const prisma = globalThis.__CELLULOID_EXACT_ID_PRISMA__;");
  }
  if (specifier === "@/lib/actions" || normalized.endsWith("/src/lib/actions")) {
    return stub(
      "export async function addFromTmdb() { throw new Error('unexpected title write'); }" +
      "export async function rematchTitle() { throw new Error('unexpected title write'); }",
    );
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "const s = globalThis.__CELLULOID_EXACT_ID_TMDB__;" +
      "const record = (fn, arg, options) => s.calls.push({ fn, arg, signal: options?.signal });" +
      "export async function findByImdbId(id, options) { record('findByImdbId', id, options); return s.imdb; }" +
      "export async function findTvByTvdbId(id, options) { record('findTvByTvdbId', id, options); return s.tvdb; }" +
      "export async function getMovie(id, options) { record('getMovie', id, options); throw new Error('TMDB 404'); }" +
      "export async function getTv(id, options) { record('getTv', id, options); if (!s.tv[id]) throw new Error('TMDB 404'); return s.tv[id]; }" +
      "export async function searchByType(kind, name, page, options) { record('searchByType', name, options); return s.search; }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { commitImportJobChunk, resolveByExactId, stageParsedImport } = await import(
  "../src/lib/import-staging"
);

const row = (overrides: Partial<ParsedTitle>): ParsedTitle => ({
  source: "upload",
  mediaType: "tv",
  name: "Friends",
  releaseDateText: null,
  releaseDate: null,
  status: "WATCHED",
  languageHint: null,
  ...overrides,
});

const friends = {
  id: 1668,
  name: "Friends",
  original_name: "Friends",
  first_air_date: "1994-09-22",
  poster_path: "/friends.jpg",
  original_language: "en",
};

beforeEach(() => {
  tmdbState.calls.length = 0;
  tmdbState.imdb = [];
  tmdbState.tvdb = [];
  tmdbState.tv = {};
  tmdbState.search = [];
  db.items = [];
  db.libraryTvIds = [];
});

describe("resolveByExactId (TM-12)", { concurrency: false }, () => {
  it("leaves an IMDb episode id unresolved rather than matching its series", async () => {
    // Live, /find/tt2301451 (Breaking Bad S5E14) returns only
    // tv_episode_results, which findByImdbId reports as no titles.
    const signal = new AbortController().signal;

    const found = await resolveByExactId(row({ name: "Ozymandias", imdbId: "tt2301451" }), signal);

    assert.equal(found, null);
    assert.deepEqual(
      tmdbState.calls.map((call) => [call.fn, call.arg, call.signal === signal]),
      [["findByImdbId", "tt2301451", true]],
    );
  });

  it("uses a TVDB series id when the row has no other id that matched", async () => {
    tmdbState.tvdb = [{ ...friends, media_type: "tv" }];
    const signal = new AbortController().signal;

    const found = await resolveByExactId(row({ tvdbId: 79168 }), signal);

    assert.equal(found?.id, 1668);
    assert.deepEqual(
      tmdbState.calls.map((call) => [call.fn, call.arg, call.signal === signal]),
      [["findTvByTvdbId", 79168, true]],
    );
  });

  it("falls back to the TVDB id when the IMDb id matched nothing", async () => {
    tmdbState.tvdb = [{ ...friends, media_type: "tv" }];
    const found = await resolveByExactId(
      row({ imdbId: "tt9999999", tvdbId: 79168 }),
      new AbortController().signal,
    );
    assert.equal(found?.id, 1668);
    assert.deepEqual(
      tmdbState.calls.map((call) => call.fn),
      ["findByImdbId", "findTvByTvdbId"],
    );
  });

  it("passes the staging signal to TMDB-id detail lookups", async () => {
    const signal = new AbortController().signal;
    assert.equal(await resolveByExactId(row({ tmdbId: 42 }), signal), null);
    assert.deepEqual(
      tmdbState.calls.map((call) => [call.fn, call.signal === signal]),
      [
        ["getTv", true],
        ["getMovie", true],
      ],
    );
  });
});

describe("an IMDb episode-id row in a ratings export (TM-12 regression)", { concurrency: false }, () => {
  const breakingBad = {
    id: 1396,
    media_type: "tv",
    name: "Breaking Bad",
    original_name: "Breaking Bad",
    first_air_date: "2008-01-20",
    poster_path: "/bb.jpg",
    original_language: "en",
  };
  // "Title Type: TV Episode", "Date Rated" and "Your Rating" parse to a
  // watched, rated TV row whose IMDb id names one episode.
  const episodeRow = row({
    name: "Ozymandias",
    imdbId: "tt2301451",
    status: "WATCHED",
    rating: 10,
    ratingText: "10",
    watchedAt: "2024-03-01",
  });

  for (const [label, libraryTvIds] of [
    ["the show is new to the library", []],
    ["the show is already on the watchlist", [1396]],
  ] as const) {
    it(`matches no show and writes nothing when ${label}`, async () => {
      db.libraryTvIds = [...libraryTvIds];
      tmdbState.tv = { 1396: breakingBad };
      // Even when the name search surfaces the show, the episode's title
      // doesn't match it.
      tmdbState.search = [breakingBad];

      const staged = await stageParsedImport({
        userId: "user-1",
        jobId: "job-1",
        parsed: [episodeRow],
        summary: {},
      });

      assert.equal(tmdbState.calls.some((call) => call.fn === "getTv"), false);
      const [item] = staged.items;
      assert.equal(item.proposed, null);
      assert.equal(item.matchScore, null);
      assert.equal(item.action, "CONFLICT");
      assert.equal(db.items[0].proposedTmdbId, null);

      // Committing touches no title: addFromTmdb and rematchTitle throw if
      // called, so no watched status or rating can reach a show.
      const committed = await commitImportJobChunk("user-1", "job-1");
      assert.equal(committed?.items[0].titleId, null);
      assert.equal(committed?.summary?.created, 0);
      assert.equal(committed?.summary?.updated, 0);
    });
  }
});
