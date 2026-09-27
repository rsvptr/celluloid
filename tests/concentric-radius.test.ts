import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

// Outer radius = inner radius + padding (Tailwind 4: rounded 4px, lg 8px, 2xl 16px).
describe("concentric radius (JK-34)", () => {
  it("My services steps down from the card radius across p-2 gaps", async () => {
    const settings = await source("../src/app/(app)/settings/my-services-section.tsx");
    // The list never rounds more than the card it sits in.
    assert.match(settings, /max-h-80 overflow-y-auto rounded-\[var\(--radius-card\)\] bg-surface-2\/50 p-2/);
    assert.match(settings, /min-h-14 min-w-0 items-center gap-2 rounded-lg p-2/);
    assert.match(settings, /h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2/);
  });

  it("the Remember filters panel is an inset-sized corner", async () => {
    const settings = await source("../src/app/(app)/settings/remember-filters-section.tsx");
    assert.match(settings, /justify-between gap-4 rounded-lg bg-surface-2\/45 p-3/);
  });

  it("TMDB result rows wrap the rounded-lg poster at 16px", async () => {
    const search = await source("../src/components/tmdb-search.tsx");
    assert.equal(search.match(/rounded-2xl bg-surface p-2\.5/g)?.length, 2);
    assert.doesNotMatch(search, /rounded-xl bg-surface p-2\.5/);
  });
});
