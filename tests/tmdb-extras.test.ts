import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WATCH_REGION,
  isWatchRegion,
  pickTrailer,
  regionWatchInfo,
} from "../src/lib/tmdb-extras";
import type { TmdbProvider, TmdbVideo } from "../src/lib/tmdb";

const p = (id: number, name: string, priority?: number): TmdbProvider => ({
  provider_id: id,
  provider_name: name,
  logo_path: `/logo${id}.png`,
  display_priority: priority,
});

describe("regionWatchInfo", () => {
  it("groups stream/rent/buy and keeps TMDB's watch link", () => {
    const info = regionWatchInfo(
      {
        US: {
          link: "https://www.themoviedb.org/tv/95396-severance/watch?locale=US",
          flatrate: [p(8, "Netflix", 1)],
          rent: [p(2, "Apple TV", 3)],
          buy: [p(2, "Apple TV", 3), p(3, "Amazon", 4)],
        },
      },
      "US",
    );
    assert.equal(info.link, "https://www.themoviedb.org/tv/95396-severance/watch?locale=US");
    assert.deepEqual(
      info.groups.map((g) => [g.label, g.providers.map((x) => x.provider_name)]),
      [
        ["Stream", ["Netflix"]],
        ["Rent", ["Apple TV"]],
        ["Buy", ["Apple TV", "Amazon"]],
      ],
    );
  });

  it("merges flatrate/free/ads into Stream, deduped and priority-sorted", () => {
    const info = regionWatchInfo(
      {
        IN: {
          flatrate: [p(1, "Hotstar", 5)],
          free: [p(9, "MX Player", 2), p(1, "Hotstar", 5)],
          ads: [p(9, "MX Player", 2)],
        },
      },
      "IN",
    );
    assert.equal(info.groups.length, 1);
    assert.deepEqual(
      info.groups[0].providers.map((x) => x.provider_name),
      ["MX Player", "Hotstar"],
    );
  });

  it("returns empty groups for a region with no data", () => {
    const info = regionWatchInfo({ US: { flatrate: [p(8, "Netflix")] } }, "JP");
    assert.equal(info.link, null);
    assert.deepEqual(info.groups, []);
  });

  it("handles an undefined results object", () => {
    assert.deepEqual(regionWatchInfo(undefined, "US"), { link: null, groups: [] });
  });

  it("caps a group at 8 providers", () => {
    const many = Array.from({ length: 12 }, (_, i) => p(i + 1, `P${i + 1}`, i));
    const info = regionWatchInfo({ US: { buy: many } }, "US");
    assert.equal(info.groups[0].providers.length, 8);
  });
});

describe("pickTrailer", () => {
  const v = (over: Partial<TmdbVideo>): TmdbVideo => ({
    site: "YouTube",
    type: "Trailer",
    key: "k",
    name: "n",
    ...over,
  });

  it("prefers the newest official trailer", () => {
    const pick = pickTrailer([
      v({ key: "old", official: true, published_at: "2020-01-01" }),
      v({ key: "unofficial", official: false, published_at: "2024-01-01" }),
      v({ key: "new", official: true, published_at: "2023-01-01" }),
    ]);
    assert.equal(pick?.key, "new");
    assert.equal(pick?.url, "https://www.youtube.com/watch?v=new");
  });

  it("falls back to any trailer, then a teaser", () => {
    assert.equal(pickTrailer([v({ key: "t", official: false })])?.key, "t");
    assert.equal(
      pickTrailer([v({ key: "z", type: "Teaser" }), v({ key: "c", type: "Clip" })])?.key,
      "z",
    );
  });

  it("ignores non-YouTube videos and returns null when nothing fits", () => {
    assert.equal(pickTrailer([v({ site: "Vimeo" })]), null);
    assert.equal(pickTrailer([]), null);
  });
});

describe("isWatchRegion", () => {
  it("accepts known regions and rejects junk", () => {
    assert.equal(isWatchRegion("IN"), true);
    assert.equal(isWatchRegion(DEFAULT_WATCH_REGION), true);
    assert.equal(isWatchRegion("XX"), false);
    assert.equal(isWatchRegion(""), false);
    assert.equal(isWatchRegion(undefined), false);
  });
});
