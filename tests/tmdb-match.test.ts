import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { norm, yearOf, nameYearKey, pickBest } from "../src/lib/tmdb-match";
import type { TmdbSearchItem } from "../src/lib/tmdb";

function movie(
  id: number,
  title: string,
  year: number | null,
  vote = 5,
): TmdbSearchItem {
  return {
    id,
    media_type: "movie",
    title,
    release_date: year ? `${year}-06-01` : undefined,
    vote_average: vote,
  };
}

describe("norm", () => {
  it("lowercases, strips accents and punctuation", () => {
    assert.equal(norm("Léon: The Professional!"), "leon the professional");
  });
  it("treats & as and", () => {
    assert.equal(norm("Law & Order"), "law and order");
  });
  it("collapses whitespace runs", () => {
    assert.equal(norm("  The   Thing  "), "the thing");
  });
});

describe("yearOf", () => {
  it("reads the release year", () => {
    assert.equal(yearOf(movie(1, "X", 1999)), 1999);
  });
  it("returns null when no date", () => {
    assert.equal(yearOf(movie(1, "X", null)), null);
  });
});

describe("nameYearKey", () => {
  it("normalizes name and includes the year", () => {
    assert.equal(nameYearKey("movie", "Léon", 1994), "movie:leon:1994");
  });
  it("uses ? for unknown year", () => {
    assert.equal(nameYearKey("tv", "Dark", null), "tv:dark:?");
  });
});

describe("pickBest", () => {
  it("returns null for no results", () => {
    assert.equal(pickBest([], "Anything", 2000), null);
  });

  it("prefers an exact name+year match over an earlier partial", () => {
    const results = [
      movie(1, "Alien Covenant", 2017, 6),
      movie(2, "Alien", 1979, 8),
    ];
    assert.equal(pickBest(results, "Alien", 1979)?.id, 2);
  });

  it("rejects results with no name overlap and no top-hit year corroboration", () => {
    const results = [
      movie(1, "Completely Different Film", 1990),
      movie(2, "Another Unrelated Thing", 2005),
    ];
    assert.equal(pickBest(results, "Bramayugam", 2024), null);
  });

  it("accepts TMDB's top hit for a transliterated title when the year matches", () => {
    // No substring overlap between query and result, but it's the #1 hit with
    // a matching year, which is the transliteration carve-out.
    const results = [movie(7, "Bramayugam", 2024, 7.5)];
    assert.equal(pickBest(results, "ഭ്രമയുഗം", 2024)?.id, 7);
  });

  it("does not let the carve-out pass when the year is two off", () => {
    const results = [movie(7, "Some Other Film", 2022)];
    assert.equal(pickBest(results, "ഭ്രമയുഗം", 2024), null);
  });

  it("year within one still corroborates the top hit", () => {
    const results = [movie(9, "Romanized Name", 2023)];
    assert.equal(pickBest(results, "completely different script", 2024)?.id, 9);
  });
});
