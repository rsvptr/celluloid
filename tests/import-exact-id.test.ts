import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";
import type { ParsedTitle } from "../src/lib/import/parse-excel";

type Call = { fn: string; arg: unknown; signal: unknown };
type TmdbState = {
  calls: Call[];
  imdb: { titles: unknown[]; episodeShowIds: number[] };
  tvdb: unknown[];
  tv: Record<number, unknown>;
};

const tmdbState: TmdbState = { calls: [], imdb: { titles: [], episodeShowIds: [] }, tvdb: [], tv: {} };
Object.assign(globalThis, { __CELLULOID_EXACT_ID_TMDB__: tmdbState });

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
    return stub("export const prisma = {};");
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
      "export async function searchByType() { throw new Error('unexpected search'); }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { resolveByExactId } = await import("../src/lib/import-staging");

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
  tmdbState.imdb = { titles: [], episodeShowIds: [] };
  tmdbState.tvdb = [];
  tmdbState.tv = {};
});

describe("resolveByExactId (TM-12)", { concurrency: false }, () => {
  it("resolves an IMDb episode id to its series", async () => {
    // Live, /find/tt0583459 (Friends S1E1) returns only tv_episode_results.
    tmdbState.imdb = { titles: [], episodeShowIds: [1668] };
    tmdbState.tv = { 1668: friends };
    const signal = new AbortController().signal;

    const found = await resolveByExactId(row({ imdbId: "tt0583459" }), signal);

    assert.equal(found?.id, 1668);
    assert.equal(found?.media_type, "tv");
    assert.equal(found?.name, "Friends");
    assert.deepEqual(
      tmdbState.calls.map((call) => [call.fn, call.arg, call.signal === signal]),
      [
        ["findByImdbId", "tt0583459", true],
        ["getTv", 1668, true],
      ],
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
