import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { norm, yearOf, nameYearKey, pickBest, resultNames } from "../src/lib/tmdb-match";
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

// TM-05: TMDB searches original titles too. Live, "Ladri di biciclette" with
// primary_release_year=1948 returned exactly this one result.
const bicycleThieves: TmdbSearchItem = {
  id: 5156,
  media_type: "movie",
  title: "Bicycle Thieves",
  original_title: "Ladri di biciclette",
  release_date: "1948-07-21",
};

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

  it("year within one still corroborates the top hit for an unnormalizable query", () => {
    // Different non-Latin script than the other carve-out cases, and a
    // one-year (not exact) diff, so this exercises the "<= 1" branch on its
    // own unnormalizable query.
    const results = [movie(9, "Romanized Name", 2023)];
    assert.equal(pickBest(results, "另一部电影", 2024)?.id, 9);
  });

  it("does not let a normal (normalizable) non-matching query ride the carve-out on a close year", () => {
    // Regression for the carve-out being too broad: a real, normalizable
    // query with zero name overlap must not hijack TMDB's top hit just
    // because its year is within one of the target.
    const results = [movie(9, "Romanized Name", 2023)];
    assert.equal(pickBest(results, "completely different script", 2024), null);
  });

  it("matches a row written in the original language by the original title", () => {
    assert.equal(pickBest([bicycleThieves], "Ladri di biciclette", 1948)?.id, 5156);
    assert.equal(pickBest([bicycleThieves], "Bicycle Thieves", 1948)?.id, 5156);
  });

  it("prefers an exact original-title match over an earlier partial localized one", () => {
    const results = [movie(1, "Ladri", 1948, 6), bicycleThieves];
    assert.equal(pickBest(results, "Ladri di biciclette", 1948)?.id, 5156);
  });

  it("does the same for TV original names", () => {
    const moneyHeist: TmdbSearchItem = {
      id: 71446,
      media_type: "tv",
      name: "Money Heist",
      original_name: "La casa de papel",
      first_air_date: "2017-05-02",
    };
    assert.equal(pickBest([moneyHeist], "La casa de papel", 2017)?.id, 71446);
  });
});

describe("resultNames", () => {
  it("lists the localized and original names, normalized", () => {
    assert.deepEqual(resultNames(bicycleThieves), ["bicycle thieves", "ladri di biciclette"]);
  });

  it("drops names that normalize to nothing, such as a non-Latin original", () => {
    assert.deepEqual(
      resultNames({ title: "Bramayugam", original_title: "ഭ്രമയുഗം" }),
      ["bramayugam"],
    );
    assert.deepEqual(resultNames({}), []);
  });
});
