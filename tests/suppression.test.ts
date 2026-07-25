import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enrichRec,
  isSuppressedByName,
  mergeExcludeNames,
  suppressionContext,
  suppressionMatchKey,
  PROMPT_EXCLUDE_CAP,
  type Recommendation,
  type StreamContext,
  type SuppressionRow,
} from "../src/lib/recommend";
import { MediaType } from "../src/generated/prisma/client";
import type { TmdbSearchItem } from "../src/lib/tmdb";

// --- helpers ---------------------------------------------------------------

function row(overrides: Partial<SuppressionRow> = {}): SuppressionRow {
  return {
    tmdbId: null,
    mediaType: MediaType.MOVIE,
    name: "The Thing",
    year: 1982,
    ...overrides,
  };
}

function ctx(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    existingSet: new Set(),
    libNameYear: new Set(),
    excludeSet: new Set(),
    seenKeys: new Set(),
    ...overrides,
  };
}

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    title: "The Thing",
    year: 1982,
    mediaType: "movie",
    reason: "Because you rated bleak, practical-effects horror highly.",
    confidence: "high",
    ...overrides,
  };
}

function movie(id: number, title: string, year: number | null): TmdbSearchItem {
  return {
    id,
    media_type: "movie",
    title,
    release_date: year ? `${year}-10-10` : undefined,
    vote_average: 8,
  };
}

// --- suppressionMatchKey ---------------------------------------------------

describe("suppressionMatchKey", () => {
  it("keys on the TMDB id when the suggestion resolved", () => {
    assert.equal(
      suppressionMatchKey({ mediaType: "movie", tmdbId: 1091, name: "The Thing", year: 1982 }),
      "tmdb:MOVIE:1091",
    );
    assert.equal(
      suppressionMatchKey({ mediaType: "tv", tmdbId: 46648, name: "True Detective" }),
      "tmdb:TV:46648",
    );
  });

  it("keys on the normalized name and year when it did not", () => {
    assert.equal(
      suppressionMatchKey({ mediaType: "movie", name: "Amélie!", year: 2001 }),
      "name:movie:amelie|2001",
    );
    assert.equal(
      suppressionMatchKey({ mediaType: "tv", name: "Fargo", year: null }),
      "name:tv:fargo|?",
    );
  });

  it("gives the same key for cosmetic spelling differences", () => {
    const a = suppressionMatchKey({ mediaType: "movie", name: "Fire & Ice", year: 1983 });
    const b = suppressionMatchKey({ mediaType: "movie", name: "Fire and  Ice", year: 1983 });
    assert.equal(a, b);
  });
});

// --- isSuppressedByName ----------------------------------------------------

describe("isSuppressedByName", () => {
  it("matches the same title and year", () => {
    const s = suppressionContext([row()]);
    assert.equal(isSuppressedByName(s, "movie", "The Thing", 1982), true);
  });

  it("does not bury another year of the same name", () => {
    const s = suppressionContext([row({ year: 2011 })]);
    assert.equal(isSuppressedByName(s, "movie", "The Thing", 1982), false);
  });

  it("matches any year when the suppression has none", () => {
    const s = suppressionContext([row({ year: null })]);
    assert.equal(isSuppressedByName(s, "movie", "The Thing", 1982), true);
    assert.equal(isSuppressedByName(s, "movie", "The Thing", null), true);
  });

  it("does not cross media types", () => {
    const s = suppressionContext([row({ mediaType: MediaType.TV })]);
    assert.equal(isSuppressedByName(s, "movie", "The Thing", 1982), false);
    assert.equal(isSuppressedByName(s, "tv", "The Thing", 1982), true);
  });

  it("is a no-op without a loaded suppression context", () => {
    assert.equal(isSuppressedByName(undefined, "movie", "The Thing", 1982), false);
  });
});

// --- enrichRec + suppression ------------------------------------------------

describe("enrichRec with suppressions", () => {
  it("drops a suggestion suppressed by TMDB id even when the name differs", async () => {
    const suppressed = suppressionContext([
      row({ tmdbId: 1091, name: "The Thing from Another World", year: null }),
    ]);
    // Name and year both differ from the stored row; only the resolved id matches.
    const out = await enrichRec(
      rec({ title: "The Thing", year: 1982 }),
      ctx({ suppressed }),
      async () => [movie(1091, "The Thing", 1982)],
    );
    assert.equal(out, null);
  });

  it("drops a suggestion suppressed under the year TMDB supplied", async () => {
    const suppressed = suppressionContext([row({ year: 1982 })]);
    // The model gave no year, so the pre-lookup name check could not fire.
    const out = await enrichRec(
      rec({ year: null }),
      ctx({ suppressed }),
      async () => [movie(1091, "The Thing", 1982)],
    );
    assert.equal(out, null);
  });

  it("keeps a suggestion that is not suppressed", async () => {
    const suppressed = suppressionContext([row({ name: "Alien", year: 1979 })]);
    const out = await enrichRec(rec(), ctx({ suppressed }), async () => [
      movie(1091, "The Thing", 1982),
    ]);
    assert.equal(out?.tmdbId, 1091);
  });
});

// --- mergeExcludeNames ------------------------------------------------------

describe("mergeExcludeNames", () => {
  it("keeps both sources, session titles first", () => {
    assert.deepEqual(mergeExcludeNames(["Alien"], ["Heat"]), ["Alien", "Heat"]);
  });

  it("drops duplicates across the two sources", () => {
    assert.deepEqual(mergeExcludeNames(["Amélie"], ["Amelie", "Heat"]), ["Amélie", "Heat"]);
  });

  it("reserves room for suppressions when the session list is long", () => {
    const seen = Array.from({ length: 200 }, (_, i) => `Seen ${i}`);
    const suppressedNames = Array.from({ length: 10 }, (_, i) => `Refused ${i}`);
    const out = mergeExcludeNames(seen, suppressedNames);
    assert.equal(out.length, PROMPT_EXCLUDE_CAP);
    for (const name of suppressedNames) assert.ok(out.includes(name), name);
  });

  it("gives unused reserved slots back to the session titles", () => {
    const seen = Array.from({ length: 200 }, (_, i) => `Seen ${i}`);
    const out = mergeExcludeNames(seen, []);
    assert.equal(out.length, PROMPT_EXCLUDE_CAP);
    assert.equal(out[PROMPT_EXCLUDE_CAP - 1], `Seen ${PROMPT_EXCLUDE_CAP - 1}`);
  });

  it("never exceeds the clause cap", () => {
    const seen = Array.from({ length: 300 }, (_, i) => `Seen ${i}`);
    const suppressedNames = Array.from({ length: 300 }, (_, i) => `Refused ${i}`);
    assert.equal(mergeExcludeNames(seen, suppressedNames).length, PROMPT_EXCLUDE_CAP);
  });
});
