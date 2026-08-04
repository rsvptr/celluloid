import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeWatchProviderCatalogues,
  type TmdbProvider,
} from "../src/lib/tmdb";

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
