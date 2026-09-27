import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

const { searchByType } = await import("../src/lib/tmdb");

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
