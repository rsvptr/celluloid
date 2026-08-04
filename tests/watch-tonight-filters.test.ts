import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filtersToParams,
  parseLibraryFilters,
} from "../src/lib/library-filters";

const EMPTY_FACETS = { languages: [], tags: [], genres: [] };

describe("On my services library URL state", () => {
  it("accepts only the explicit services=1 flag", () => {
    assert.equal(
      parseLibraryFilters({ services: "1" }, EMPTY_FACETS).onlyOnServices,
      true,
    );
    assert.equal(
      parseLibraryFilters({ services: "true" }, EMPTY_FACETS).onlyOnServices,
      undefined,
    );
  });

  it("round-trips the enabled filter without changing plain defaults", () => {
    const filters = parseLibraryFilters({ services: "1" }, EMPTY_FACETS);
    assert.equal(filtersToParams(filters).get("services"), "1");
    assert.equal(
      filtersToParams(parseLibraryFilters({}, EMPTY_FACETS)).toString(),
      "",
    );
  });
});
