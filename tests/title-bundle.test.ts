import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

const { getTitleBundle } = await import("../src/lib/tmdb");

process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Answers every TMDB request with `detail` and records the request URLs. */
function serve(detail: object) {
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(String(input)));
    return Response.json(detail);
  }) as typeof fetch;
  return urls;
}

describe("getTitleBundle", { concurrency: false }, () => {
  it("asks for videos in the given languages on the one bundle request (TM-10)", async () => {
    const urls = serve({ id: 1166133, recommendations: { results: [{ id: 1 }] } });
    await getTitleBundle("movie", 1166133, "US", ["en", "ml", "null"]);
    assert.equal(urls.length, 1);
    assert.equal(urls[0].pathname, "/3/movie/1166133");
    assert.equal(urls[0].searchParams.get("include_video_language"), "en,ml,null");
    assert.match(urls[0].searchParams.get("append_to_response") ?? "", /(^|,)videos(,|$)/);
  });

  it("carries the viewer's region's release dates for a movie and none for TV", async () => {
    serve({
      id: 1166133,
      recommendations: { results: [{ id: 1 }] },
      release_dates: {
        results: [
          { iso_3166_1: "IN", release_dates: [{ type: 3, certification: "", release_date: "2024-02-15T00:00:00.000Z" }] },
        ],
      },
    });
    const movie = await getTitleBundle("movie", 1166133, "IN", ["en"]);
    assert.deepEqual(movie.releases, [{ type: 3, date: "2024-02-15T00:00:00.000Z" }]);
    const tv = await getTitleBundle("tv", 1166133, "IN", ["en"]);
    assert.deepEqual(tv.releases, []);
  });

  it("marks the last aired and next episodes TMDB calls finales, for TV only", async () => {
    serve({
      id: 95396,
      recommendations: { results: [{ id: 1 }] },
      last_episode_to_air: { season_number: 2, episode_number: 10, episode_type: "finale" },
      next_episode_to_air: { season_number: 3, episode_number: 1, episode_type: "standard" },
    });
    const tv = await getTitleBundle("tv", 95396, "US", ["en"]);
    assert.deepEqual(tv.episodeTypes, [{ seasonNumber: 2, episodeNumber: 10, type: "finale" }]);
    const movie = await getTitleBundle("movie", 95396, "US", ["en"]);
    assert.deepEqual(movie.episodeTypes, []);
  });
});

