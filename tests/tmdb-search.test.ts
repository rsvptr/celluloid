import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

const { findByImdbId, findTvByTvdbId, searchByType } = await import("../src/lib/tmdb");

process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Serves `pages` in order and records each request's year filter. */
function servePages(pages: object[][]) {
  const years: Array<string | null> = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    years.push(url.searchParams.get("primary_release_year"));
    return Response.json({ page: 1, results: pages[years.length - 1] ?? [], total_pages: 1 });
  }) as typeof fetch;
  return years;
}

const bicycleThieves = {
  id: 5156,
  title: "Bicycle Thieves",
  original_title: "Ladri di biciclette",
  release_date: "1948-07-21",
};

describe("searchByType year retry (TM-05)", { concurrency: false }, () => {
  it("needs no unfiltered search when the original title is on the filtered page", async () => {
    const years = servePages([[bicycleThieves]]);
    const results = await searchByType("movie", "Ladri di biciclette", 1, { year: 1948 });
    assert.deepEqual(years, ["1948"]);
    assert.deepEqual(results.map((r) => r.id), [5156]);
  });

  it("still retries unfiltered when neither name is on the filtered page", async () => {
    const years = servePages([[{ id: 1, title: "Other", original_title: "Autre" }], [bicycleThieves]]);
    const results = await searchByType("movie", "Ladri di biciclette", 1, { year: 1949 });
    assert.deepEqual(years, ["1949", null]);
    assert.deepEqual(results.map((r) => r.id), [1, 5156]);
  });
});

describe("external id lookups (TM-12)", { concurrency: false }, () => {
  function serveFind(body: object) {
    const urls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(new URL(String(input)));
      return Response.json(body);
    }) as typeof fetch;
    return urls;
  }

  it("returns an IMDb episode id's series id alongside any titles", async () => {
    // Live shape of /find/tt0583459 (Friends S1E1).
    serveFind({
      movie_results: [],
      tv_results: [],
      tv_episode_results: [{ id: 85987, show_id: 1668, season_number: 1, episode_number: 1 }],
    });
    assert.deepEqual(await findByImdbId("tt0583459"), { titles: [], episodeShowIds: [1668] });
  });

  it("looks a TVDB id up as tvdb_id and keeps only the series match", async () => {
    // Live, /find/79168?external_source=tvdb_id: Friends, plus an episode of
    // an unrelated show that shares the number.
    const urls = serveFind({
      movie_results: [],
      tv_results: [{ id: 1668, name: "Friends", first_air_date: "1994-09-22" }],
      tv_episode_results: [{ id: 279192, show_id: 4018, season_number: 4, episode_number: 1 }],
    });
    const found = await findTvByTvdbId(79168);
    assert.equal(urls[0].pathname, "/3/find/79168");
    assert.equal(urls[0].searchParams.get("external_source"), "tvdb_id");
    assert.deepEqual(
      found.map((item) => [item.id, item.media_type]),
      [[1668, "tv"]],
    );
  });

  it("makes no request for a malformed id", async () => {
    const urls = serveFind({});
    assert.deepEqual(await findByImdbId("not-an-id"), { titles: [], episodeShowIds: [] });
    assert.deepEqual(await findTvByTvdbId(0), []);
    assert.equal(urls.length, 0);
  });
});
