import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  DEFAULT_FILTERS,
  filtersToParams,
  parseLibraryFilters,
  type LibraryFilters,
} from "../src/lib/library-filters";
import {
  libraryMirrorFilters,
  libraryUrlFilters,
  toLibraryFilterState,
} from "../src/lib/library-filter-state";

const FACETS = { languages: ["en", "ja"], tags: ["comfort"], genres: ["Drama"] };

/** What the page's cache holds for `/?type=movie`, before the search was mirrored. */
const STALE: LibraryFilters = { ...DEFAULT_FILTERS, type: "MOVIE" };

// Type "bar" on /?type=movie, open a title, press Back: the address bar is
// /?q=bar&type=movie, but the page comes back as rendered for /?type=movie.
describe("libraryUrlFilters (Back after a mirrored search)", () => {
  it("takes the search and filters from the address bar over a stale page", () => {
    const filters = libraryUrlFilters(STALE, new URLSearchParams("q=bar&type=movie"), FACETS);
    assert.equal(filters.query, "bar");
    assert.equal(filters.type, "MOVIE");
  });

  it("gives back exactly the state that was mirrored", () => {
    const states = [
      toLibraryFilterState({ ...DEFAULT_FILTERS, query: "amélie", view: "list" }),
      toLibraryFilterState({
        query: "rashomon",
        type: "MOVIE",
        status: "WATCHED",
        language: "ja",
        tag: "comfort",
        genre: "Drama",
        rating: "8",
        sort: "name",
        view: "list",
        onlyUnmatched: true,
        onlyOnServices: true,
      }),
    ];
    for (const state of states) {
      const url = filtersToParams(libraryMirrorFilters(state));
      assert.deepEqual(toLibraryFilterState(libraryUrlFilters(STALE, url, FACETS)), state);
    }
  });

  it("keeps the server's filters for a bare URL, which is where remembered filters apply", () => {
    const remembered: LibraryFilters = { ...DEFAULT_FILTERS, type: "TV", view: "list" };
    assert.equal(libraryUrlFilters(remembered, new URLSearchParams(""), FACETS), remembered);
    assert.equal(libraryUrlFilters(remembered, new URLSearchParams("utm=x"), FACETS), remembered);
  });

  it("matches the server's parse, facet checks and first-value rule included", () => {
    const query = "q=a&q=b&type=tv&lang=xx&tag=comfort&sort=name";
    const url = new URLSearchParams(query);
    const server = parseLibraryFilters(
      { q: ["a", "b"], type: "tv", lang: "xx", tag: "comfort", sort: "name" },
      FACETS,
    );
    assert.deepEqual(libraryUrlFilters(DEFAULT_FILTERS, url, FACETS), server);
    assert.equal(server.query, "a");
    assert.equal(server.language, "all");
  });
});

describe("Library reads its filters from the address bar", () => {
  it("starts from, and adopts, the URL filters, and mirrors again after a server re-render", async () => {
    const source = await readFile(new URL("../src/components/library.tsx", import.meta.url), "utf8");
    assert.match(source, /const urlFilters = libraryUrlFilters\(initialFilters, searchParams,/);
    assert.match(source, /useReducer\(\s*libraryFiltersReducer,\s*urlFilters,\s*toLibraryFilterState,?\s*\)/);
    assert.match(source, /dispatchFilters\(\{ type: "adopt", filters: urlFilters \}\)/);
    // Adopting still keys on the server prop, so the mirror's own URL change
    // can't reset what's being typed.
    assert.match(source, /const incomingFilterKey = libraryFilterKey\(initialFilters\);/);
    assert.match(source, /\}, \[filters, rememberFilters, initialFilters\]\);/);
  });
});
