import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLibraryFilters } from "../src/lib/library-filters";
// The feature is deliberately two modules — Zod-free client encoders/writers,
// strict server parsers — and these tests exercise the pair as one contract.
import {
  encodeExportRememberedState,
  encodeLibraryRememberedState,
  encodeRecommendRememberedState,
  isRememberFiltersEnabled,
  REMEMBERED_COOKIE_NAMES,
  writeRememberedCookie,
} from "../src/lib/remembered-state-client";
import {
  hasExplicitExportScopeParams,
  hasExplicitLibraryFilterParams,
  libraryRememberedStateToParams,
  parseExportRememberedState,
  parseLibraryRememberedState,
  parseRecommendRememberedState,
} from "../src/lib/remembered-state";

describe("remembered-state cookies", () => {
  it("defaults the device toggle on and honors only the explicit opt-out", () => {
    assert.equal(isRememberFiltersEnabled(undefined), true);
    assert.equal(isRememberFiltersEnabled("1"), true);
    assert.equal(isRememberFiltersEnabled("junk"), true);
    assert.equal(isRememberFiltersEnabled("0"), false);
  });

  it("round-trips library filters without storing search text", () => {
    const encoded = encodeLibraryRememberedState({
      query: "do not persist me",
      type: "TV",
      status: "WATCHING",
      language: "ja",
      tag: "weekend",
      genre: "Drama",
      rating: "8",
      sort: "release",
      view: "list",
      onlyUnmatched: true,
      onlyOnServices: true,
    });
    assert.ok(encoded);
    assert.ok(encoded.length < 1024);
    const parsed = parseLibraryRememberedState(encoded);
    assert.equal("query" in (parsed ?? {}), false);
    assert.deepEqual(libraryRememberedStateToParams(parsed), {
      type: "tv",
      status: "watching",
      lang: "ja",
      tag: "weekend",
      genre: "Drama",
      rating: "8",
      sort: "release",
      view: "list",
      unmatched: "1",
      services: "1",
    });
  });

  it("lets the library validator discard remembered facets that no longer exist", () => {
    const encoded = encodeLibraryRememberedState({
      query: "",
      type: "TV",
      status: "WATCHING",
      language: "ja",
      tag: "retired tag",
      genre: "Old genre",
      rating: "8",
      sort: "release",
      view: "list",
      onlyUnmatched: false,
      onlyOnServices: false,
    });
    const filters = parseLibraryFilters(
      libraryRememberedStateToParams(parseLibraryRememberedState(encoded)),
      { languages: ["en"], tags: [], genres: [] },
    );
    assert.equal(filters.language, "all");
    assert.equal(filters.tag, "all");
    assert.equal(filters.genre, "all");
    assert.equal(filters.type, "TV");
    assert.equal(filters.view, "list");
  });

  it("round-trips bounded recommendation and export preferences", () => {
    const recommend = encodeRecommendRememberedState({
      count: 20,
      type: "movie",
      preset: "Spooky",
      language: "en",
      genre: "Horror",
      era: "1990s",
      basisMode: "recent",
      recentCount: 50,
    });
    assert.equal(parseRecommendRememberedState(recommend)?.count, 20);

    const exported = encodeExportRememberedState("xlsx", {
      type: "movie",
      status: "WATCHED",
      favoritesOnly: true,
      tag: "weekend",
      language: "en",
      genre: "Drama",
      minRating: 8,
      yearFrom: 1990,
      yearTo: 1999,
    });
    assert.equal(parseExportRememberedState(exported)?.format, "xlsx");
  });

  it("falls back on corrupt, unknown-version, oversized, or extra-field payloads", () => {
    assert.equal(parseLibraryRememberedState("%not-json"), null);
    assert.equal(
      parseLibraryRememberedState(
        encodeURIComponent(JSON.stringify({ v: 2, type: "all" })),
      ),
      null,
    );
    assert.equal(parseLibraryRememberedState("x".repeat(4000)), null);
    assert.equal(
      parseLibraryRememberedState("%20".repeat(400)),
      null,
      "encoded payloads are capped by bytes, not decoded character count",
    );

    const valid = parseRecommendRememberedState(
      encodeURIComponent(
        JSON.stringify({
          v: 1,
          count: 12,
          type: "all",
          preset: null,
          language: "",
          genre: "",
          era: "",
          basisMode: "all",
          recentCount: 20,
          secret: "must be rejected",
        }),
      ),
    );
    assert.equal(valid, null);
  });

  it("detects explicit surface parameters so deep links win over cookies", () => {
    assert.equal(hasExplicitLibraryFilterParams({}), false);
    assert.equal(hasExplicitLibraryFilterParams({ q: "" }), true);
    assert.equal(hasExplicitLibraryFilterParams({ unrelated: "1" }), false);
    assert.equal(hasExplicitExportScopeParams({}), false);
    assert.equal(hasExplicitExportScopeParams({ fav: "0" }), true);
  });

  it("prevents a stale open surface from writing after the device opts out", () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const writes: string[] = [];
    let visibleCookies = "celluloid-remember-filters=0";
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get cookie() {
          return visibleCookies;
        },
        set cookie(value: string) {
          writes.push(value);
        },
      },
    });

    try {
      writeRememberedCookie(REMEMBERED_COOKIE_NAMES.library, "%7B%7D");
      assert.equal(writes.length, 0);

      visibleCookies = "";
      writeRememberedCookie(REMEMBERED_COOKIE_NAMES.library, "%7B%7D");
      assert.equal(writes.length, 1);
      assert.match(writes[0], /Path=\/; Max-Age=31536000; SameSite=Lax/);
    } finally {
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });
});
