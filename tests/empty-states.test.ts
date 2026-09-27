import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("library empty states (JK-31)", () => {
  it("hides the filter and utility rows on first run, unless Trash has titles", async () => {
    const library = (await Promise.all(["library", "library-toolbar", "library-results"].map((name) => source(`../src/components/${name}.tsx`)))).join("\n");
    assert.match(library, /const firstRun = items\.length === 0 && trashedCount === 0;/);
    assert.match(library, /cn\("flex flex-wrap items-center gap-2", firstRun && "hidden"\)/);
    assert.match(library, /cn\("flex flex-wrap items-center justify-end gap-2", firstRun && "hidden"\)/);
    assert.match(library, /Titles you add show up here with your progress and ratings\./);
  });

  it("names the query when nothing matches, and offers the right way back", async () => {
    const library = (await Promise.all(["library", "library-toolbar", "library-filter-panel", "library-results", "library-bulk-bar", "library-trash", "library-filters-context"].map((name) => source(`../src/components/${name}.tsx`)))).join("\n");
    assert.match(library, /`No titles match “\$\{query\.trim\(\)\}”\$\{searchOnly \? "\." : " with these filters\."\}`/);
    assert.match(library, /searchOnly=\{query !== "" && !filtersBesidesSearch\}/);
    assert.match(library, /\{searchOnly \? "Clear search" : "Clear filters"\}/);
    assert.doesNotMatch(library, /Try clearing filters/);
  });

  it("offers Surprise only when the view has something to pick", async () => {
    const library = await source("../src/components/library.tsx");
    assert.match(library, /\{filtered\.length > 0 && \(\s*<button\s+onClick=\{surprise\}/);
  });
});

describe("empty season (JK-31)", () => {
  it("says no episodes are announced and offers no mark button or panel", async () => {
    const tracker = await source("../src/app/(app)/title/[id]/season-tracker.tsx");
    assert.match(tracker, /sTotal === 0 \? "No episodes announced yet" : `\$\{sWatched\}\/\$\{sTotal\}`/);
    assert.match(tracker, /\{sTotal > 0 && \(\s*<button\s+onClick=\{\(\) => void requestSeasonToggle/);
    assert.match(tracker, /\{isOpen && sTotal > 0 && \(/);
    assert.match(tracker, /disabled=\{sTotal === 0\}\s+aria-expanded=\{sTotal > 0 \? isOpen : undefined\}/);
  });
});
