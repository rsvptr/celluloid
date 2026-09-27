import assert from "node:assert/strict";
import { describe, it } from "node:test";
import "./server-only-shim";
import type { TmdbProvider } from "../src/lib/tmdb";

const { getWatchRegions, mergeWatchProviderCatalogues } = await import("../src/lib/tmdb");

function provider(
  id: number,
  name: string,
  priority: number,
  logoPath: string | null = null,
): TmdbProvider {
  return {
    provider_id: id,
    provider_name: name,
    logo_path: logoPath,
    display_priority: priority,
  };
}

describe("mergeWatchProviderCatalogues", () => {
  it("deduplicates movie/TV rows and sorts by the best regional priority", () => {
    const merged = mergeWatchProviderCatalogues(
      [
        [provider(8, "Netflix", 3, "/netflix.jpg"), provider(9, "Prime Video", 1)],
        [provider(8, "Netflix", 0), provider(337, "Disney Plus", 2)],
      ],
      "GB",
    );

    assert.deepEqual(
      merged.map((row) => [row.provider_id, row.display_priority]),
      [
        [8, 0],
        [9, 1],
        [337, 2],
      ],
    );
    assert.equal(merged[0]?.logo_path, "/netflix.jpg");
  });

  it("prefers display_priorities for the requested region", () => {
    const merged = mergeWatchProviderCatalogues(
      [
        [
          {
            ...provider(1, "One", 0),
            display_priorities: { US: 10, GB: 4 },
          },
          {
            ...provider(2, "Two", 20),
            display_priorities: { US: 2, GB: 8 },
          },
        ],
      ],
      "GB",
    );

    assert.deepEqual(merged.map((row) => row.provider_id), [1, 2]);
    assert.deepEqual(merged.map((row) => row.display_priority), [4, 8]);
  });

  it("drops invalid provider ids and uses name as a stable tie-break", () => {
    const merged = mergeWatchProviderCatalogues(
      [[provider(0, "Invalid", 0), provider(2, "Zulu", 5), provider(1, "Alpha", 5)]],
      "US",
    );

    assert.deepEqual(merged.map((row) => row.provider_name), ["Alpha", "Zulu"]);
  });
});

describe("getWatchRegions", { concurrency: false }, () => {
  it("returns TMDB's region codes sorted by name, cached for 30 days", async () => {
    const originalFetch = globalThis.fetch;
    process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init });
      // The live shape of /watch/providers/regions, trimmed.
      return Response.json({
        results: [
          { iso_3166_1: "AD", english_name: "Andorra", native_name: "Andorra" },
          { iso_3166_1: "US", english_name: "United States of America" },
          { iso_3166_1: "NL", english_name: "Netherlands" },
          { iso_3166_1: "bad" },
        ],
      });
    }) as typeof fetch;
    try {
      assert.deepEqual(await getWatchRegions(), ["AD", "NL", "US"]);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url.pathname, "/3/watch/providers/regions");
      assert.equal(calls[0].init?.next?.revalidate, 60 * 60 * 24 * 30);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
