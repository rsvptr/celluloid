import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FILTERS,
  filtersToParams,
  parseLibraryFilters,
  type LibraryFilters,
} from "../src/lib/library-filters";

const FACETS = {
  languages: ["en", "ml", "ja"],
  tags: ["horror night", "comfort"],
  genres: ["Horror", "Drama"],
};

describe("parseLibraryFilters", () => {
  it("returns defaults for empty params", () => {
    assert.deepEqual(parseLibraryFilters({}, FACETS), DEFAULT_FILTERS);
  });

  it("parses a full valid set", () => {
    const f = parseLibraryFilters(
      {
        q: "bram",
        type: "movie",
        status: "watched",
        lang: "ml",
        tag: "horror night",
        genre: "Horror",
        rating: "8",
        sort: "myrating",
        view: "list",
        unmatched: "1",
      },
      FACETS,
    );
    assert.deepEqual(f, {
      query: "bram",
      type: "MOVIE",
      status: "WATCHED",
      language: "ml",
      tag: "horror night",
      genre: "Horror",
      rating: "8",
      sort: "myrating",
      view: "list",
      onlyUnmatched: true,
    } satisfies LibraryFilters);
  });

  it("rejects facet values the library doesn't contain", () => {
    const f = parseLibraryFilters(
      { lang: "fr", tag: "nope", genre: "Sci-Fi" },
      FACETS,
    );
    assert.equal(f.language, "all");
    assert.equal(f.tag, "all");
    assert.equal(f.genre, "all");
  });

  it("rejects junk enum values and bounds the query", () => {
    const f = parseLibraryFilters(
      { type: "podcast", status: "binged", rating: "11", sort: "hax", q: "x".repeat(500) },
      FACETS,
    );
    assert.equal(f.type, "all");
    assert.equal(f.status, "all");
    assert.equal(f.rating, "all");
    assert.equal(f.sort, "added");
    assert.equal(f.query.length, 200);
  });

  it("takes the first value of a repeated param", () => {
    const f = parseLibraryFilters({ type: ["tv", "movie"] }, FACETS);
    assert.equal(f.type, "TV");
  });
});

describe("filtersToParams", () => {
  it("serializes defaults to an empty string", () => {
    assert.equal(filtersToParams(DEFAULT_FILTERS).toString(), "");
  });

  it("round-trips through parse", () => {
    const filters: LibraryFilters = {
      query: "night",
      type: "TV",
      status: "ON_HOLD",
      language: "ja",
      tag: "comfort",
      genre: "Drama",
      rating: "unrated",
      sort: "release",
      view: "list",
      onlyUnmatched: true,
    };
    const params = filtersToParams(filters);
    const back = parseLibraryFilters(
      Object.fromEntries(params.entries()),
      FACETS,
    );
    assert.deepEqual(back, filters);
  });
});
