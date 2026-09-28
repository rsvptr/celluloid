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
    for (const remember of [true, false]) {
      const filters = libraryUrlFilters(STALE, new URLSearchParams("q=bar&type=movie"), FACETS, remember);
      assert.equal(filters.query, "bar");
      assert.equal(filters.type, "MOVIE");
    }
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
      assert.deepEqual(toLibraryFilterState(libraryUrlFilters(STALE, url, FACETS, true)), state);
    }
  });

  it("keeps the server's filters for a bare URL with remember-filters on, where the cookie applies", () => {
    const remembered: LibraryFilters = { ...DEFAULT_FILTERS, type: "TV", view: "list" };
    assert.equal(libraryUrlFilters(remembered, new URLSearchParams(""), FACETS, true), remembered);
    assert.equal(libraryUrlFilters(remembered, new URLSearchParams("utm=x"), FACETS, true), remembered);
  });

  // Rendered for /?type=movie, cleared (the mirror writes a bare /), a title,
  // then Back: the page comes back as rendered for /?type=movie.
  it("gives a bare URL the defaults with remember-filters off, as the server does, not a stale page's filters", () => {
    for (const query of ["", "utm=x"]) {
      const filters = libraryUrlFilters(STALE, new URLSearchParams(query), FACETS, false);
      assert.deepEqual(filters, DEFAULT_FILTERS);
      assert.deepEqual(filters, parseLibraryFilters(Object.fromEntries(new URLSearchParams(query)), FACETS));
    }
  });

  it("matches the server's parse, facet checks and first-value rule included", () => {
    const query = "q=a&q=b&type=tv&lang=xx&tag=comfort&sort=name";
    const url = new URLSearchParams(query);
    const server = parseLibraryFilters(
      { q: ["a", "b"], type: "tv", lang: "xx", tag: "comfort", sort: "name" },
      FACETS,
    );
    assert.deepEqual(libraryUrlFilters(DEFAULT_FILTERS, url, FACETS, false), server);
    assert.equal(server.query, "a");
    assert.equal(server.language, "all");
  });
});

describe("Library reads its filters from the address bar", () => {
  it("starts from, and adopts, the URL filters, and mirrors again after a server re-render", async () => {
    const source = await readFile(new URL("../src/components/library.tsx", import.meta.url), "utf8");
    assert.match(
      source,
      /const urlFilters = libraryUrlFilters\(\s*initialFilters,\s*searchParams,\s*\{ languages, tags, genres \},\s*rememberFilters,?\s*\)/,
    );
    assert.match(source, /useReducer\(\s*libraryFiltersReducer,\s*urlFilters,\s*toLibraryFilterState,?\s*\)/);
    assert.match(source, /dispatchFilters\(\{ type: "adopt", filters: urlFilters \}\)/);
    assert.match(source, /\}, \[filters, rememberFilters, initialFilters\]\);/);
  });

  it("adopts only when the router's URL changes, never on a re-render of the same URL", async () => {
    const source = await readFile(new URL("../src/components/library.tsx", import.meta.url), "utf8");
    // Neither the mirror's replaceState nor a server re-render changes the
    // router's URL, so neither can reset what's being typed. Keying on the
    // server's filters instead let an action's re-render for a bare URL (the
    // cookie's filters, no search) clear the search.
    assert.match(source, /const urlKey = searchParams\.toString\(\);/);
    assert.match(source, /if \(urlKey !== appliedUrlKey\) \{\s*setAppliedUrlKey\(urlKey\);\s*dispatchFilters/);
    assert.doesNotMatch(source, /libraryFilterKey|FilterKey\(initialFilters\)/);
    // Keying the component on filter state remounted it after every action,
    // dropping select mode, the selection, the panel and Trash mode.
    const page = await readFile(new URL("../src/app/(app)/page.tsx", import.meta.url), "utf8");
    assert.match(page, /<Library\s/);
    assert.doesNotMatch(page, /<Library[^>]*\skey=/);
  });
});
