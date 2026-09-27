import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { DEFAULT_FILTERS } from "../src/lib/library-filters";
import {
  libraryChipFocusAfterRemoval,
  libraryFilterChips,
  toLibraryFilterState,
} from "../src/lib/library-filter-state";

const chips = libraryFilterChips(
  toLibraryFilterState({ ...DEFAULT_FILTERS, status: "WATCHED", genre: "Drama", tag: "comfort" }),
);

// Removing a chip, or clearing them all, unmounted the focused button and
// dropped focus on <body>.
describe("focus after removing a library filter chip", () => {
  it("moves to the chip that takes the removed one's place", () => {
    assert.deepEqual(chips.map((c) => c.key), ["status", "genre", "tag"]);
    assert.equal(libraryChipFocusAfterRemoval(chips, "status"), "genre");
    assert.equal(libraryChipFocusAfterRemoval(chips, "genre"), "tag");
  });

  it("moves to the chip before when the last one goes, and to none for the only one", () => {
    assert.equal(libraryChipFocusAfterRemoval(chips, "tag"), "genre");
    assert.equal(libraryChipFocusAfterRemoval(chips.slice(0, 1), "status"), null);
    assert.equal(libraryChipFocusAfterRemoval(chips, "language"), null);
  });

  it("is wired so the chip or the fallback gets focus after the removal renders", async () => {
    const toolbar = await readFile(new URL("../src/components/library-toolbar.tsx", import.meta.url), "utf8");
    const row = toolbar.slice(toolbar.indexOf("export function LibraryFilterChips("));
    assert.match(row, /data-chip=\{chip\.key\}/);
    assert.match(
      row,
      /const next = libraryChipFocusAfterRemoval\(facetChips, chip\.key\);\s*flushSync\(\(\) => set\(chip\.clear\)\);\s*focusChipOrFallback\(next\);/,
    );
    assert.match(row, /flushSync\(clear\);\s*focusChipOrFallback\(null\);\s*\}\}[\s\S]*?Clear all/);
    assert.match(row, /\(chip \?\? fallbackFocusRef\.current\)\?\.focus\(\);/);

    const library = await readFile(new URL("../src/components/library.tsx", import.meta.url), "utf8");
    assert.match(
      library,
      /<LibraryFilterChips fallbackFocusRef=\{firstRun \? searchInputRef : filtersTriggerRef\} \/>/,
    );
  });
});
