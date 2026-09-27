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
  hasFiltersBesidesSearch,
  hasLibraryFilters,
  libraryExportHref,
  libraryFilterChips,
  libraryFiltersReducer,
  libraryMirrorFilters,
  libraryResultsKey,
  toLibraryFilterState,
  type LibraryFilterState,
} from "../src/lib/library-filter-state";

const BASE: LibraryFilterState = toLibraryFilterState(DEFAULT_FILTERS);

/** Every field set away from its default. */
const FULL: LibraryFilterState = {
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
};

const FACETS = { languages: ["en", "ja"], tags: ["comfort"], genres: ["Drama"] };

describe("toLibraryFilterState", () => {
  it("always holds onlyOnServices as a boolean", () => {
    assert.equal(DEFAULT_FILTERS.onlyOnServices, undefined);
    assert.deepEqual(BASE, { ...DEFAULT_FILTERS, onlyOnServices: false });
    assert.equal(toLibraryFilterState(FULL).onlyOnServices, true);
  });
});

describe("libraryFiltersReducer", () => {
  it("sets one field or a patch", () => {
    const one = libraryFiltersReducer(BASE, { type: "set", update: { type: "TV" } });
    assert.deepEqual(one, { ...BASE, type: "TV" });
    const patch = libraryFiltersReducer(BASE, {
      type: "set",
      update: { status: "WATCHING", sort: "tmdb" },
    });
    assert.deepEqual(patch, { ...BASE, status: "WATCHING", sort: "tmdb" });
    assert.deepEqual(BASE, toLibraryFilterState(DEFAULT_FILTERS), "state is not mutated");
  });

  it("toggles from the state it is applied to", () => {
    const toggle = {
      type: "set",
      update: (f: LibraryFilterState) => ({ onlyOnServices: !f.onlyOnServices }),
    } as const;
    const on = libraryFiltersReducer(BASE, toggle);
    assert.equal(on.onlyOnServices, true);
    assert.equal(libraryFiltersReducer(on, toggle).onlyOnServices, false);
  });

  it("returns the same state when a set changes nothing", () => {
    // What a separate useState setter did: an unchanged value is a no-op, so
    // the mirror effect and the results memo don't run again.
    assert.equal(libraryFiltersReducer(BASE, { type: "set", update: { type: "all" } }), BASE);
    assert.equal(libraryFiltersReducer(FULL, { type: "set", update: { ...FULL } }), FULL);
    assert.equal(libraryFiltersReducer(BASE, { type: "set", update: {} }), BASE);
  });

  it("adopts every field of incoming filters, defaulting onlyOnServices to off", () => {
    const adopted = libraryFiltersReducer(FULL, { type: "adopt", filters: DEFAULT_FILTERS });
    assert.deepEqual(adopted, BASE);
    assert.deepEqual(libraryFiltersReducer(BASE, { type: "adopt", filters: FULL }), FULL);
  });

  it("adopting the URL it mirrored changes nothing", () => {
    // The re-render that ends every bulk and Trash action carries the params
    // this state was mirrored into; adopting them must keep the same object.
    for (const state of [BASE, FULL, { ...BASE, query: "amélie", view: "list" as const }]) {
      const params = Object.fromEntries(filtersToParams(libraryMirrorFilters(state)));
      const reparsed = parseLibraryFilters(params, FACETS);
      assert.equal(libraryFiltersReducer(state, { type: "adopt", filters: reparsed }), state);
    }
  });

  it("clears every narrowing field and keeps sort and view", () => {
    const cleared = libraryFiltersReducer(FULL, { type: "clear" });
    assert.deepEqual(cleared, { ...BASE, sort: "name", view: "list" });
    assert.equal(hasLibraryFilters(cleared), false);
    assert.equal(libraryFiltersReducer(cleared, { type: "clear" }), cleared);
  });
});

describe("hasLibraryFilters and hasFiltersBesidesSearch", () => {
  it("are off for the defaults, with or without onlyOnServices", () => {
    for (const f of [DEFAULT_FILTERS, BASE]) {
      assert.equal(hasLibraryFilters(f), false);
      assert.equal(hasFiltersBesidesSearch(f), false);
    }
  });

  it("count the search, untrimmed, only in hasLibraryFilters", () => {
    for (const query of ["dune", " "]) {
      assert.equal(hasLibraryFilters({ ...BASE, query }), true, query);
      assert.equal(hasFiltersBesidesSearch({ ...BASE, query }), false, query);
    }
  });

  it("count each narrowing field on its own", () => {
    const narrowing: Partial<LibraryFilters>[] = [
      { type: "TV" },
      { status: "DROPPED" },
      { language: "ja" },
      { tag: "comfort" },
      { genre: "Drama" },
      { rating: "unrated" },
      { rating: "5" },
      { onlyUnmatched: true },
      { onlyOnServices: true },
    ];
    for (const patch of narrowing) {
      assert.equal(hasFiltersBesidesSearch({ ...BASE, ...patch }), true, JSON.stringify(patch));
      assert.equal(hasLibraryFilters({ ...BASE, ...patch }), true, JSON.stringify(patch));
    }
  });

  it("ignore sort and view", () => {
    const ordered = { ...BASE, sort: "release" as const, view: "list" as const };
    assert.equal(hasLibraryFilters(ordered), false);
  });
});

describe("libraryFilterChips", () => {
  it("lists the advanced facets in order, with their labels", () => {
    assert.deepEqual(
      libraryFilterChips(FULL).map(({ key, label }) => [key, label]),
      [
        ["status", "Status: Watched"],
        ["language", "Language: Japanese"],
        ["genre", "Genre: Drama"],
        ["rating", "Rating: 8+"],
        ["tag", "Tag: comfort"],
        ["unmatched", "Needs match"],
      ],
    );
    assert.equal(libraryFilterChips({ ...BASE, rating: "unrated" })[0].label, "Rating: Unrated");
  });

  it("has no chip for the search, type, On my services, sort or view", () => {
    assert.deepEqual(
      libraryFilterChips({
        ...BASE,
        query: "dune",
        type: "TV",
        onlyOnServices: true,
        sort: "name",
        view: "list",
      }),
      [],
    );
  });

  it("clears exactly its own facet", () => {
    for (const chip of libraryFilterChips(FULL)) {
      const next = libraryFiltersReducer(FULL, { type: "set", update: chip.clear });
      assert.deepEqual(
        libraryFilterChips(next).map((c) => c.key),
        libraryFilterChips(FULL).map((c) => c.key).filter((key) => key !== chip.key),
      );
      assert.equal(next.query, FULL.query);
      assert.equal(next.type, FULL.type);
    }
  });
});

describe("libraryExportHref", () => {
  it("is the bare Export page with nothing to carry over", () => {
    assert.equal(libraryExportHref(BASE), "/export");
  });

  it("carries the facets Export understands", () => {
    assert.equal(
      libraryExportHref(FULL),
      "/export?type=movie&status=WATCHED&tag=comfort&genre=Drama&lang=ja&min=8",
    );
    assert.equal(libraryExportHref({ ...BASE, type: "TV" }), "/export?type=tv");
  });

  it("leaves out what Export has no equivalent for", () => {
    assert.equal(
      libraryExportHref({
        ...BASE,
        query: "dune",
        rating: "unrated",
        sort: "name",
        view: "list",
        onlyUnmatched: true,
        onlyOnServices: true,
      }),
      "/export",
    );
  });
});

describe("libraryMirrorFilters", () => {
  it("trims the search and keeps every other field", () => {
    assert.deepEqual(libraryMirrorFilters({ ...FULL, query: "  rashomon " }), FULL);
    assert.equal(filtersToParams(libraryMirrorFilters({ ...BASE, query: "   " })).toString(), "");
  });
});

describe("whitespace-only search", () => {
  it("doesn't count as a filter once trimmed, as the results trim it", () => {
    for (const query of [" ", "   ", "\t "]) {
      assert.equal(hasLibraryFilters(libraryMirrorFilters({ ...BASE, query })), false, JSON.stringify(query));
    }
    assert.equal(hasLibraryFilters(libraryMirrorFilters({ ...BASE, query: " dune " })), true);
    assert.equal(hasLibraryFilters(libraryMirrorFilters({ ...BASE, query: " ", type: "TV" })), true);
  });

  it("decides the count's \"of N\" and Export these on the trimmed filters", async () => {
    for (const file of ["library-toolbar", "library-filter-panel"]) {
      const source = await readFile(new URL(`../src/components/${file}.tsx`, import.meta.url), "utf8");
      assert.match(source, /const hasFilters = hasLibraryFilters\(libraryMirrorFilters\(state\)\);/, file);
      assert.doesNotMatch(source, /hasLibraryFilters\(state\)/, file);
    }
  });
});

describe("libraryResultsKey", () => {
  it("ignores the search text and the view", () => {
    const key = libraryResultsKey(BASE);
    assert.equal(libraryResultsKey({ ...BASE, query: "dune" }), key);
    assert.equal(libraryResultsKey({ ...BASE, view: "list" }), key);
  });

  it("changes with every field that narrows or orders the results", () => {
    const key = libraryResultsKey(BASE);
    for (const field of Object.keys(FULL) as (keyof LibraryFilterState)[]) {
      if (field === "query" || field === "view") continue;
      assert.notEqual(libraryResultsKey({ ...BASE, [field]: FULL[field] }), key, field);
    }
  });

  it("parses back to the criteria", () => {
    const criteria: Partial<LibraryFilterState> = { ...FULL };
    delete criteria.query;
    delete criteria.view;
    assert.deepEqual(JSON.parse(libraryResultsKey(FULL)), criteria);
  });
});
