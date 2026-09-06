import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRequestBlock,
  enrichRec,
  genreFilterAdvisory,
  isValidRec,
  selectRecentBasis,
  sharedAiBudgetError,
  shouldSendThinkingHeartbeat,
  terminalRecEvents,
  type Recommendation,
  type StreamContext,
} from "../src/lib/recommend";
import { nameYearKey } from "../src/lib/tmdb-match";
import { languageName } from "../src/lib/format";
import { MediaType } from "../src/generated/prisma/client";
import type { TmdbSearchItem } from "../src/lib/tmdb";
import type { ExportRow } from "../src/lib/export/format";

// --- helpers ---------------------------------------------------------------

function rec(overrides: Partial<Recommendation> = {}): Recommendation {
  return {
    title: "Whiplash",
    year: 2014,
    mediaType: "movie",
    reason: "Because you rated intense character studies highly.",
    confidence: "high",
    ...overrides,
  };
}

function ctx(overrides: Partial<StreamContext> = {}): StreamContext {
  return {
    existingSet: new Set(),
    libNameYear: new Set(),
    excludeSet: new Set(),
    seenKeys: new Set(),
    resolvedKeys: new Set(),
    ...overrides,
  };
}

/** A stubbed TMDB search that returns a fixed result set (no live call). */
function stubSearch(results: TmdbSearchItem[]) {
  return async () => results;
}

function movie(
  id: number,
  title: string,
  year: number | null,
  extra: Partial<TmdbSearchItem> = {},
): TmdbSearchItem {
  return {
    id,
    media_type: "movie",
    title,
    release_date: year ? `${year}-10-10` : undefined,
    vote_average: 8,
    ...extra,
  };
}

/** A minimal ExportRow for selectRecentBasis tests. */
function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    id: "id",
    tmdbId: null,
    name: "Title",
    mediaType: "movie",
    year: 2020,
    releaseDate: "2020-01-01",
    languageCode: "en",
    language: "English",
    statusKey: "WATCHED",
    status: "Watched",
    myRating: null,
    tmdbRating: null,
    genres: [],
    totalEpisodes: null,
    watchedEpisodes: 0,
    watchCount: 0,
    favorite: false,
    notes: null,
    tags: [],
    watchedAt: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("thinking heartbeat throttle", () => {
  it("sends immediately when needed, then at most once every five seconds", () => {
    assert.equal(shouldSendThinkingHeartbeat(null, 10_000), true);
    assert.equal(shouldSendThinkingHeartbeat(10_000, 14_999), false);
    assert.equal(shouldSendThinkingHeartbeat(10_000, 15_000), true);
    assert.equal(shouldSendThinkingHeartbeat(15_000, 15_001), false);
  });
});

describe("shared AI budget gate", () => {
  it("never reserves a shared run for a personal key", async () => {
    let calls = 0;
    const error = await sharedAiBudgetError(false, async () => {
      calls += 1;
      return { allowed: false, day: "2026-08-29", limit: 1, runCount: null };
    });

    assert.equal(error, null);
    assert.equal(calls, 0);
  });

  it("allows a successful shared reservation and explains an exhausted one", async () => {
    assert.equal(
      await sharedAiBudgetError(true, async () => ({
        allowed: true,
        day: "2026-08-29",
        limit: 20,
        runCount: 8,
      })),
      null,
    );
    assert.match(
      (await sharedAiBudgetError(true, async () => ({
        allowed: false,
        day: "2026-08-29",
        limit: 20,
        runCount: null,
      }))) ?? "",
      /personal Anthropic API key in Settings/,
    );
  });
});

// --- isValidRec ------------------------------------------------------------

describe("isValidRec", () => {
  const valid = {
    title: "Dune",
    year: 2021,
    mediaType: "movie",
    language: "en",
    reason: "Epic, deliberate sci-fi like your top-rated titles.",
    confidence: "high",
  };

  it("accepts a fully-populated recommendation", () => {
    assert.equal(isValidRec(valid), true);
  });

  it("does not require year or language (only the core fields)", () => {
    assert.equal(
      isValidRec({ title: "Dark", mediaType: "tv", reason: "why", confidence: "low" }),
      true,
    );
  });

  it("rejects non-objects", () => {
    for (const x of [null, undefined, "Dune", 42, true, []]) {
      assert.equal(isValidRec(x), false);
    }
  });

  it("rejects a missing / empty / non-string title", () => {
    assert.equal(isValidRec({ ...valid, title: "" }), false);
    assert.equal(isValidRec({ ...valid, title: "   " }), false);
    assert.equal(isValidRec({ ...valid, title: 5 }), false);
    const { title: _drop, ...noTitle } = valid;
    void _drop;
    assert.equal(isValidRec(noTitle), false);
  });

  it("rejects an invalid mediaType", () => {
    assert.equal(isValidRec({ ...valid, mediaType: "book" }), false);
    assert.equal(isValidRec({ ...valid, mediaType: undefined }), false);
  });

  it("rejects a missing / empty reason", () => {
    assert.equal(isValidRec({ ...valid, reason: "" }), false);
    assert.equal(isValidRec({ ...valid, reason: "   " }), false);
    assert.equal(isValidRec({ ...valid, reason: 123 }), false);
  });

  it("rejects an out-of-enum confidence", () => {
    assert.equal(isValidRec({ ...valid, confidence: "meh" }), false);
    assert.equal(isValidRec({ ...valid, confidence: undefined }), false);
  });
});

// --- enrichRec -------------------------------------------------------------

describe("enrichRec", () => {
  it("attaches the TMDB match (id, poster, resolved year, language)", async () => {
    const results = [
      movie(555, "Whiplash", 2014, { poster_path: "/w.jpg", original_language: "en" }),
    ];
    // Model omitted the year; TMDB supplies it.
    const out = await enrichRec(rec({ year: null, language: null }), ctx(), stubSearch(results));
    assert.ok(out);
    assert.equal(out.tmdbId, 555);
    assert.equal(out.posterPath, "/w.jpg");
    assert.equal(out.year, 2014);
    assert.equal(out.language, "en");
  });

  it("passes the media type and title through to the search", async () => {
    const calls: Array<[string, string]> = [];
    const spy = async (mt: "movie" | "tv", title: string) => {
      calls.push([mt, title]);
      return [movie(555, "Whiplash", 2014)];
    };
    await enrichRec(rec(), ctx(), spy);
    assert.deepEqual(calls, [["movie", "Whiplash"]]);
  });

  it("drops a suggestion already in the library by tmdbId", async () => {
    const results = [movie(123, "The Matrix", 1999)];
    const c = ctx({ existingSet: new Set([`${MediaType.MOVIE}:123`]) });
    const out = await enrichRec(rec({ title: "The Matrix", year: 1999 }), c, stubSearch(results));
    assert.equal(out, null);
  });

  it("drops a suggestion already in the library by name+year", async () => {
    const results = [movie(555, "Whiplash", 2014)];
    const c = ctx({ libNameYear: new Set([nameYearKey("movie", "Whiplash", 2014)]) });
    const out = await enrichRec(rec({ year: 2014 }), c, stubSearch(results));
    assert.equal(out, null);
  });

  it("re-checks ownership with the TMDB-supplied year the model omitted", async () => {
    const results = [movie(555, "Whiplash", 2014)];
    const c = ctx({ libNameYear: new Set([nameYearKey("movie", "Whiplash", 2014)]) });
    // Model gave no year; the name+year dedup must still fire off TMDB's 2014.
    const out = await enrichRec(rec({ year: null }), c, stubSearch(results));
    assert.equal(out, null);
  });

  it("drops two model suggestions that resolve to the same TMDB title", async () => {
    const results = [movie(1091, "The Thing", 1982)];
    const c = ctx();
    const first = await enrichRec(
      rec({ title: "The Thing", year: 1982 }),
      c,
      stubSearch(results),
    );
    const duplicate = await enrichRec(
      rec({ title: "The Thing", year: 1983 }),
      c,
      stubSearch(results),
    );

    assert.equal(first?.tmdbId, 1091);
    assert.equal(duplicate, null);
  });

  it("returns the rec unenriched when TMDB has no credible match", async () => {
    const r = rec();
    const out = await enrichRec(r, ctx(), stubSearch([]));
    assert.equal(out, r); // same object, no tmdbId attached
    assert.equal(out?.tmdbId, undefined);
  });

  it("returns the rec unenriched when the TMDB lookup throws", async () => {
    const r = rec();
    const throwing = async () => {
      throw new Error("TMDB unavailable");
    };
    const out = await enrichRec(r, ctx(), throwing);
    assert.equal(out, r);
  });
});

// --- selectRecentBasis -------------------------------------------------------

describe("selectRecentBasis", () => {
  it("excludes rows with no watchedAt (no createdAt fallback)", () => {
    const withDate = row({ id: "a", watchedAt: "2024-01-01T00:00:00.000Z" });
    // Imported with no real watch date but a fresh createdAt — must NOT be
    // treated as recent just because the row itself is new.
    const importedNoWatch = row({
      id: "b",
      watchedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const out = selectRecentBasis([withDate, importedNoWatch]);
    assert.deepEqual(out.map((r) => r.id), ["a"]);
  });

  it("excludes watchlist rows even with a watchedAt", () => {
    const watchlisted = row({
      id: "a",
      statusKey: "WATCHLIST",
      watchedAt: "2024-01-01T00:00:00.000Z",
    });
    const watched = row({ id: "b", watchedAt: "2023-01-01T00:00:00.000Z" });
    const out = selectRecentBasis([watchlisted, watched]);
    assert.deepEqual(out.map((r) => r.id), ["b"]);
  });

  it("sorts by watchedAt descending (most recent first)", () => {
    const older = row({ id: "old", watchedAt: "2022-01-01T00:00:00.000Z" });
    const newer = row({ id: "new", watchedAt: "2024-06-01T00:00:00.000Z" });
    const mid = row({ id: "mid", watchedAt: "2023-03-01T00:00:00.000Z" });
    const out = selectRecentBasis([older, newer, mid]);
    assert.deepEqual(out.map((r) => r.id), ["new", "mid", "old"]);
  });

  it("caps at the requested count, defaulting to 20", () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ id: `t${i}`, watchedAt: `2024-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z` }),
    );
    assert.equal(selectRecentBasis(rows).length, 20);
    assert.equal(selectRecentBasis(rows, 5).length, 5);
    // Clamped: below 1 -> 1, above 200 -> 200.
    assert.equal(selectRecentBasis(rows, 0).length, 1);
    assert.equal(selectRecentBasis(rows, 1000).length, 25); // fewer rows than the cap
  });

  it("returns an empty list when nothing has a real watch date", () => {
    const out = selectRecentBasis([row({ watchedAt: null }), row({ watchedAt: null })]);
    assert.deepEqual(out, []);
  });
});

// --- genreFilterAdvisory ---------------------------------------------------

describe("genreFilterAdvisory", () => {
  it("warns when the selected medium has no matching TMDB genre id", () => {
    assert.equal(
      genreFilterAdvisory("Action & Adventure", "movie", new Set()),
      "TMDB doesn't list “Action & Adventure” for movies, so Celluloid treated it as guidance instead of a strict filter for this run.",
    );
  });

  it("stays quiet for an enforceable genre, no genre, or a lookup outage", () => {
    assert.equal(genreFilterAdvisory("Drama", "tv", new Set([18])), null);
    assert.equal(genreFilterAdvisory(undefined, "all", new Set()), null);
    assert.equal(genreFilterAdvisory("Drama", "all", null), null);
  });
});

// --- buildRequestBlock -----------------------------------------------------

describe("buildRequestBlock", () => {
  it("emits the right type clause", () => {
    assert.ok(buildRequestBlock(5, "movie").includes("Recommend films only."));
    assert.ok(buildRequestBlock(5, "tv").includes("Recommend TV shows only."));
    assert.ok(
      buildRequestBlock(5, "all").includes("Recommend a mix of films and TV shows."),
    );
  });

  it("threads the requested count through the ask", () => {
    const s = buildRequestBlock(7, "all");
    assert.ok(s.includes("recommend 7 titles"));
    assert.ok(s.includes("Return the full 7 suggestions"));
  });

  it("omits the hard requirement when no preferences are given", () => {
    assert.ok(!buildRequestBlock(6, "all").includes("Hard requirement"));
  });

  it("composes language + genre + era into one hard requirement", () => {
    const s = buildRequestBlock(12, "movie", undefined, undefined, "ml", "Thriller", "1990s");
    assert.ok(
      s.includes(
        ` Hard requirement: every suggestion must be originally in ${languageName("ml")}` +
          " and in the Thriller genre and released in the 1990s.",
      ),
      s,
    );
  });

  it("handles a language-only preference", () => {
    const s = buildRequestBlock(8, "all", undefined, undefined, "ja");
    assert.ok(
      s.includes(
        ` Hard requirement: every suggestion must be originally in ${languageName("ja")}.`,
      ),
      s,
    );
  });

  it("handles a genre + era preference without a language", () => {
    const s = buildRequestBlock(10, "tv", undefined, undefined, undefined, "Comedy", "2010s");
    assert.ok(
      s.includes(
        " Hard requirement: every suggestion must be in the Comedy genre and released in the 2010s.",
      ),
      s,
    );
    assert.ok(s.includes("Recommend TV shows only."));
  });

  it("weaves in the focus and exclusion clauses", () => {
    const s = buildRequestBlock(9, "all", "cozy mysteries", ["Alien", "Heat"]);
    assert.ok(s.includes('Pay special attention to this request: "cozy mysteries".'));
    assert.ok(s.includes("do NOT suggest any of them again: Alien, Heat."));
  });
});

// --- terminalRecEvents -------------------------------------------------------

describe("terminalRecEvents", () => {
  it("leaves the terminal explanation to the caller when the run was aborted", () => {
    const events = terminalRecEvents(0, 12, {
      hitMaxTokens: false,
      hitRefusal: false,
      aborted: true,
    });
    assert.deepEqual(events, []);
  });

  it("emits a distinct refusal error when nothing was accepted", () => {
    const events = terminalRecEvents(0, 12, { hitMaxTokens: false, hitRefusal: true });
    assert.deepEqual(events, [
      {
        type: "error",
        error:
          "Claude declined this request. This can happen when the brief or focus text trips a safety filter, so reword it and try again.",
      },
    ]);
  });

  it("lets the run finish normally (no error) when a refusal follows at least one accepted pick", () => {
    const events = terminalRecEvents(3, 12, { hitMaxTokens: false, hitRefusal: true });
    assert.deepEqual(events, [{ type: "done", total: 3 }]);
  });

  it("prioritizes the refusal message over max_tokens when both fired with nothing accepted", () => {
    const events = terminalRecEvents(0, 12, { hitMaxTokens: true, hitRefusal: true });
    assert.deepEqual(events, [
      {
        type: "error",
        error:
          "Claude declined this request. This can happen when the brief or focus text trips a safety filter, so reword it and try again.",
      },
    ]);
  });

  it("keeps the existing max_tokens error when nothing was accepted and no refusal fired", () => {
    const events = terminalRecEvents(0, 12, { hitMaxTokens: true, hitRefusal: false });
    assert.deepEqual(events, [
      {
        type: "error",
        error:
          "Claude ran out of room before finishing a single suggestion. Ask for fewer titles, or pick a shorter focus, and try again.",
      },
    ]);
  });

  it("keeps the generic empty-result error when neither flag fired", () => {
    const events = terminalRecEvents(0, 12, { hitMaxTokens: false, hitRefusal: false });
    assert.deepEqual(events, [
      {
        type: "error",
        error: "Claude didn't return any usable suggestions. Try again, or tweak your focus.",
      },
    ]);
  });

  it("keeps the max_tokens warning-then-done behavior untouched by the refusal flag", () => {
    const events = terminalRecEvents(3, 5, { hitMaxTokens: true, hitRefusal: false });
    assert.deepEqual(events, [
      {
        type: "warning",
        message: "Claude hit its length limit after 3 of 5 suggestions. Ask for fewer titles for a complete set.",
      },
      { type: "done", total: 3 },
    ]);
  });

  it("emits only done when every requested suggestion was accepted", () => {
    const events = terminalRecEvents(5, 5, { hitMaxTokens: false, hitRefusal: false });
    assert.deepEqual(events, [{ type: "done", total: 5 }]);
  });
});

// --- hard requirements + lookup outages (CEL-15) ----------------------------

describe("enrichRec hard-requirement enforcement", () => {
  const tallied = () => ({ filteredOut: 0, lookupFailed: 0 });

  it("emits TMDB's year when it differs from the model's claim", async () => {
    const out = await enrichRec(
      rec({ year: 2020 }),
      ctx(),
      stubSearch([movie(901, "Whiplash", 2021)]),
    );
    assert.equal(out?.year, 2021);
    assert.equal(out?.tmdbId, 901);
  });

  it("drops a resolved match that violates the language requirement and tallies it", async () => {
    const tallies = tallied();
    const out = await enrichRec(
      rec(),
      ctx({ requirements: { language: "ja" }, tallies }),
      stubSearch([movie(902, "Whiplash", 2014, { original_language: "en" })]),
    );
    assert.equal(out, null);
    assert.equal(tallies.filteredOut, 1);
  });

  it("keeps a resolved match that satisfies the language requirement", async () => {
    const tallies = tallied();
    const out = await enrichRec(
      rec(),
      ctx({ requirements: { language: "ja" }, tallies }),
      stubSearch([movie(903, "Whiplash", 2014, { original_language: "ja" })]),
    );
    assert.equal(out?.tmdbId, 903);
    assert.equal(tallies.filteredOut, 0);
  });

  it("enforces era against the model's own claim when TMDB has no match", async () => {
    const tallies = tallied();
    const out = await enrichRec(
      rec({ year: 2014 }),
      ctx({ requirements: { era: { from: 1990, to: 1999 } }, tallies }),
      stubSearch([]),
    );
    assert.equal(out, null);
    assert.equal(tallies.filteredOut, 1);
  });

  it("keeps an unresolved suggestion whose claims can't be checked", async () => {
    const tallies = tallied();
    const r = rec({ year: null });
    const out = await enrichRec(
      r,
      ctx({ requirements: { language: "ja" }, tallies }),
      stubSearch([]),
    );
    assert.equal(out, r);
    assert.equal(tallies.filteredOut, 0);
  });

  it("drops a genre mismatch but keeps matches and unknowns", async () => {
    const horror = new Set([27]);
    const tallies = tallied();
    const mismatch = await enrichRec(
      rec(),
      ctx({ requirements: { genreIds: horror }, tallies }),
      stubSearch([movie(904, "Whiplash", 2014, { genre_ids: [18] })]),
    );
    assert.equal(mismatch, null);
    assert.equal(tallies.filteredOut, 1);

    const match = await enrichRec(
      rec(),
      ctx({ requirements: { genreIds: horror }, tallies: tallied() }),
      stubSearch([movie(905, "Whiplash", 2014, { genre_ids: [27, 53] })]),
    );
    assert.equal(match?.tmdbId, 905);

    const unknown = await enrichRec(
      rec(),
      ctx({ requirements: { genreIds: horror }, tallies: tallied() }),
      stubSearch([movie(906, "Whiplash", 2014)]),
    );
    assert.equal(unknown?.tmdbId, 906);
  });

  it("drops a match whose TMDB date is in the future", async () => {
    const tallies = tallied();
    const out = await enrichRec(
      rec(),
      ctx({ tallies }),
      stubSearch([movie(907, "Whiplash", 2014, { release_date: "2100-01-01" })]),
    );
    assert.equal(out, null);
    assert.equal(tallies.filteredOut, 1);
  });

  it("tallies a lookup failure and still returns the suggestion unverified", async () => {
    const tallies = tallied();
    const r = rec();
    const throwing = async () => {
      throw new Error("TMDB unavailable");
    };
    const out = await enrichRec(r, ctx({ tallies }), throwing);
    assert.equal(out, r);
    assert.equal(tallies.lookupFailed, 1);
  });

  it("drops a known language/year contradiction when the lookup fails", async () => {
    const tallies = tallied();
    const throwing = async () => {
      throw new Error("TMDB unavailable");
    };
    const out = await enrichRec(
      rec({ language: "en", year: 2020 }),
      ctx({
        requirements: { language: "fr", era: { from: 1990, to: 1999 } },
        tallies,
      }),
      throwing,
    );

    assert.equal(out, null);
    assert.deepEqual(tallies, { filteredOut: 1, lookupFailed: 0 });
  });
});

describe("terminalRecEvents requirement/outage warnings", () => {
  const base = { hitMaxTokens: false, hitRefusal: false };

  it("warns about lookup failures even when the batch filled", () => {
    const events = terminalRecEvents(5, 5, { ...base, lookupFailed: 2 });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "warning");
    assert.match((events[0] as { message: string }).message, /TMDB/);
    assert.deepEqual(events[1], { type: "done", total: 5 });
  });

  it("warns about filtered drops only when the batch fell short", () => {
    const short = terminalRecEvents(3, 10, { ...base, filteredOut: 4 });
    assert.equal(short[0].type, "warning");
    assert.match((short[0] as { message: string }).message, /dropped/);
    assert.deepEqual(short.at(-1), { type: "done", total: 3 });

    const full = terminalRecEvents(10, 10, { ...base, filteredOut: 4 });
    assert.deepEqual(full, [{ type: "done", total: 10 }]);
  });
});
