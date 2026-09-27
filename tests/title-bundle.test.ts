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
});
