import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SCOPE,
  exportFilename,
  filterRows,
  sanitizeScope,
  tasteSummary,
  toAiPrompt,
  type ExportRow,
  type ExportScope,
} from "../src/lib/export/format";

let seq = 0;
function row(over: Partial<ExportRow> = {}): ExportRow {
  seq += 1;
  return {
    id: `t${seq}`,
    name: `Title ${seq}`,
    mediaType: "movie",
    year: 2020,
    releaseDate: "2020-01-01",
    languageCode: "en",
    language: "English",
    statusKey: "WATCHED",
    status: "Watched",
    myRating: null,
    tmdbRating: 7,
    genres: ["Drama"],
    totalEpisodes: null,
    watchedEpisodes: 0,
    favorite: false,
    notes: null,
    tags: [],
    watchedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function scope(over: Partial<ExportScope> = {}): ExportScope {
  return { ...DEFAULT_SCOPE, ...over };
}

describe("filterRows", () => {
  it("filters by each facet", () => {
    const rows = [
      row({ mediaType: "movie", languageCode: "ml", genres: ["Horror"], myRating: 9, favorite: true, tags: ["gem"] }),
      row({ mediaType: "tv", languageCode: "en", genres: ["Comedy"], myRating: 5 }),
    ];
    assert.equal(filterRows(rows, scope({ type: "tv" })).length, 1);
    assert.equal(filterRows(rows, scope({ language: "ml" })).length, 1);
    assert.equal(filterRows(rows, scope({ genre: "Horror" })).length, 1);
    assert.equal(filterRows(rows, scope({ favoritesOnly: true })).length, 1);
    assert.equal(filterRows(rows, scope({ tag: "gem" })).length, 1);
    assert.equal(filterRows(rows, scope({ minRating: 8 })).length, 1);
  });

  it("minRating excludes unrated rows", () => {
    const rows = [row({ myRating: null }), row({ myRating: 8 })];
    const out = filterRows(rows, scope({ minRating: 5 }));
    assert.equal(out.length, 1);
    assert.equal(out[0].myRating, 8);
  });

  it("year range keeps only rows inside, and drops unknown years", () => {
    const rows = [
      row({ year: 1985 }),
      row({ year: 1994 }),
      row({ year: null }),
    ];
    const out = filterRows(rows, scope({ yearFrom: 1990, yearTo: 1999 }));
    assert.equal(out.length, 1);
    assert.equal(out[0].year, 1994);
  });

  it("status filter matches the status key", () => {
    const rows = [row({ statusKey: "DROPPED" }), row({ statusKey: "WATCHED" })];
    assert.equal(filterRows(rows, scope({ status: "DROPPED" })).length, 1);
  });
});

describe("sanitizeScope", () => {
  const rows = [
    row({ languageCode: "ml", genres: ["Horror"], tags: [] }),
    row({ languageCode: "en", genres: ["Drama"] }),
  ];
  const tags = ["Horror night"];

  it("falls back to defaults for junk", () => {
    const s = sanitizeScope(
      { type: "alien", status: 'WATCHED"\r\nX', tag: "nope", language: "xx", genre: "Nope", minRating: "99", yearFrom: "abc", yearTo: 1700 },
      rows,
      tags,
    );
    assert.deepEqual(s, DEFAULT_SCOPE);
  });

  it("keeps values that exist in the library", () => {
    const s = sanitizeScope(
      { type: "movie", status: "WATCHED", tag: "Horror night", language: "ml", genre: "Horror", minRating: "8", yearFrom: "1990", yearTo: "1999", favoritesOnly: "1" },
      rows,
      tags,
    );
    assert.equal(s.type, "movie");
    assert.equal(s.status, "WATCHED");
    assert.equal(s.tag, "Horror night");
    assert.equal(s.language, "ml");
    assert.equal(s.genre, "Horror");
    assert.equal(s.minRating, 8);
    assert.equal(s.yearFrom, 1990);
    assert.equal(s.yearTo, 1999);
    assert.equal(s.favoritesOnly, true);
  });
});

describe("exportFilename", () => {
  it("is timestamped and extension-correct for the default scope", () => {
    assert.match(
      exportFilename(scope(), "xlsx"),
      /^celluloid-library-\d{8}-\d{6}\.xlsx$/,
    );
  });

  it("encodes the scope as safe slugged segments", () => {
    const name = exportFilename(
      scope({
        type: "movie",
        status: "ON_HOLD",
        language: "ml",
        genre: "Action & Adventure",
        minRating: 8,
        yearFrom: 1990,
        yearTo: 1999,
        favoritesOnly: true,
      }),
      "json",
    );
    assert.match(
      name,
      /^celluloid-library-movie-on-hold-ml-action-adventure-8plus-1990-1999-favorites-\d{8}-\d{6}\.json$/,
    );
  });

  it("handles open-ended year bounds", () => {
    assert.match(exportFilename(scope({ yearFrom: 1990 }), "txt"), /-from-1990-\d{8}/);
    assert.match(exportFilename(scope({ yearTo: 1999 }), "txt"), /-to-1999-\d{8}/);
  });

  it("names AI prompt exports distinctly", () => {
    assert.match(exportFilename(scope(), "txt", "ai-prompt"), /^celluloid-ai-prompt-/);
  });
});

describe("tasteSummary", () => {
  it("splits liked and low ratings into separate signal blocks", () => {
    const rows = [
      row({ name: "Loved It", myRating: 9 }),
      row({ name: "Hated It", myRating: 2 }),
    ];
    const s = tasteSummary(rows);
    assert.ok(s.includes("WATCHED & RATED"));
    assert.ok(s.includes("Loved It"));
    assert.ok(s.includes("RATED LOW"));
    const lowBlock = s.slice(s.indexOf("RATED LOW"));
    assert.ok(lowBlock.includes("Hated It"));
  });

  it("marks favorites and tags inline and surfaces notes", () => {
    const rows = [
      row({ name: "Gem", myRating: 10, favorite: true, tags: ["rewatch"], notes: "  stunning   sound design  " }),
    ];
    const s = tasteSummary(rows);
    assert.ok(s.includes("★ Gem"));
    assert.ok(s.includes("#rewatch"));
    assert.ok(s.includes("note: stunning sound design"));
  });

  it("derives the language lean from rated and favorite rows", () => {
    const rows = [
      row({ myRating: 9, languageCode: "ml", language: "Malayalam" }),
      row({ myRating: 8, languageCode: "ml", language: "Malayalam" }),
      row({ myRating: null, languageCode: "fr", language: "French" }),
    ];
    const s = tasteSummary(rows);
    assert.ok(s.includes("I mostly watch in these languages: Malayalam"));
    assert.ok(!s.includes("French,"));
  });

  it("honors the watchlist override so scoped exports keep the guardrail", () => {
    const basis = [row({ name: "Basis Movie", myRating: 9 })];
    const fullWatchlist = [row({ name: "Planned Movie", statusKey: "WATCHLIST" })];
    const s = tasteSummary(basis, { watchlist: fullWatchlist });
    assert.ok(s.includes("Planned Movie"));
  });
});

describe("toAiPrompt", () => {
  it("asks for the requested number of titles", () => {
    const s = toAiPrompt([row({ myRating: 8 })], 25);
    assert.ok(s.includes("recommend 25 titles"));
  });
});
