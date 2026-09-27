import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WATCH_REGION,
  isWatchRegion,
  pickTrailer,
  regionWatchInfo,
  trailerLanguages,
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

  // Bramayugam's videos, live, with include_video_language=hi,en,ml,null.
  const bramayugam = [
    v({ key: "en-trailer", iso_639_1: "en", official: true }),
    v({ key: "hi-trailer", iso_639_1: "hi", official: false }),
    v({ key: "ml-trailer", iso_639_1: "ml", official: false }),
    v({ key: "ml-teaser", iso_639_1: "ml", type: "Teaser" }),
  ];

  it("prefers the earlier language, then English, then the rest (TM-10)", () => {
    assert.equal(pickTrailer(bramayugam, ["hi", "en", "ml", "null"])?.key, "hi-trailer");
    assert.equal(pickTrailer(bramayugam, ["en", "ml", "null"])?.key, "en-trailer");
    assert.equal(pickTrailer(bramayugam.slice(2), ["en", "ml", "null"])?.key, "ml-trailer");
  });

  it("keeps the tier order within one language, and falls back to unlisted ones", () => {
    const videos = [
      v({ key: "de-teaser", iso_639_1: "de", type: "Teaser" }),
      v({ key: "de-trailer", iso_639_1: "de", official: false }),
      v({ key: "fr-official", iso_639_1: "fr", official: true }),
    ];
    assert.equal(pickTrailer(videos, ["de", "en"])?.key, "de-trailer");
    assert.equal(pickTrailer(videos.slice(2), ["de", "en"])?.key, "fr-official");
  });

  it("treats an untagged video as TMDB's null language", () => {
    const videos = [v({ key: "tagged", iso_639_1: "ja" }), v({ key: "untagged", iso_639_1: null })];
    assert.equal(pickTrailer(videos, ["en", "null"])?.key, "untagged");
  });
});

describe("trailerLanguages", () => {
  it("puts the viewer's language first, then English, the original and untagged", () => {
    assert.deepEqual(trailerLanguages("de-DE,de;q=0.9,en;q=0.8", "US", "ja"), [
      "de",
      "en",
      "ja",
      "null",
    ]);
    assert.deepEqual(trailerLanguages("en-IN,en;q=0.9", "IN", "ml"), ["en", "ml", "null"]);
  });

  it("falls back to the region's usual language when the browser names none", () => {
    assert.deepEqual(trailerLanguages(null, "IN", "ml"), ["hi", "en", "ml", "null"]);
    assert.deepEqual(trailerLanguages("*", "DE", null), ["de", "en", "null"]);
    assert.deepEqual(trailerLanguages("", "JP", "ja"), ["ja", "en", "null"]);
  });

  it("does not repeat a language", () => {
    assert.deepEqual(trailerLanguages("en-US", "US", "en"), ["en", "null"]);
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
