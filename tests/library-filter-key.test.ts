import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { register } from "node:module";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const serverOnlyShim = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyShim)}`, import.meta.url);

const { libraryFilterKey } = await import("../src/components/library");
const { DEFAULT_FILTERS, parseLibraryFilters } = await import(
  "../src/lib/library-filters"
);
type LibraryFilters = import("../src/lib/library-filters").LibraryFilters;

const facets = {
  languages: ["en", "ja"],
  tags: ["comfort"],
  genres: ["Drama"],
};

/** What the server does with a URL the client mirrored. */
function reparse(key: string): LibraryFilters {
  return parseLibraryFilters(
    Object.fromEntries(new URLSearchParams(key)),
    facets,
  );
}

describe("libraryFilterKey", () => {
  it("keys an unfiltered library as the bare path", () => {
    assert.equal(libraryFilterKey(DEFAULT_FILTERS), "");
  });

  it("survives the round trip the router.refresh() takes", () => {
    // The client mirrors these filters into the URL, the refresh re-renders the
    // page from that URL, and the key that comes back has to be identical —
    // otherwise every action would look like a back/forward navigation and
    // reset select mode, the selection, the filters panel and Trash.
    const states: LibraryFilters[] = [
      DEFAULT_FILTERS,
      { ...DEFAULT_FILTERS, type: "TV", status: "WATCHING" },
      {
        ...DEFAULT_FILTERS,
        query: "rashomon",
        language: "ja",
        tag: "comfort",
        genre: "Drama",
        rating: "8",
        sort: "name",
        view: "list",
        onlyUnmatched: true,
        onlyOnServices: true,
      },
    ];
    for (const state of states) {
      const key = libraryFilterKey(state);
      assert.equal(libraryFilterKey(reparse(key)), key);
    }
  });

  it("reads an unset onlyOnServices the same as an explicit false", () => {
    // The server leaves the flag off older saved states (DEFAULT_FILTERS omits
    // it); the client stores a boolean. Keying them apart would re-apply the
    // props on every refresh.
    assert.equal(DEFAULT_FILTERS.onlyOnServices, undefined);
    assert.equal(
      libraryFilterKey(DEFAULT_FILTERS),
      libraryFilterKey({ ...DEFAULT_FILTERS, onlyOnServices: false }),
    );
  });

  it("separates filter states, so back/forward is still re-applied", () => {
    const before = libraryFilterKey({ ...DEFAULT_FILTERS, type: "TV" });
    assert.notEqual(before, libraryFilterKey(DEFAULT_FILTERS));
    assert.notEqual(before, libraryFilterKey({ ...DEFAULT_FILTERS, type: "MOVIE" }));
  });
});
