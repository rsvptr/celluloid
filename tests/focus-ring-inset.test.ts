import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("full-bleed rows draw focus inside (JK-37)", () => {
  it("defines an inset modifier after .focus-ring, unlayered like it", async () => {
    const css = await source("../src/app/globals.css");
    const ring = css.indexOf(".focus-ring:focus-visible {");
    const inset = css.indexOf(".focus-ring-inset:focus-visible {\n  outline-offset: -2px;\n}");
    assert.ok(ring > 0 && inset > ring);
  });

  it("applies it to the rows that touch an overflow-hidden list edge", async () => {
    const [library, tracker, upcoming] = await Promise.all([
      source("../src/components/library-results.tsx"),
      source("../src/app/(app)/title/[id]/season-tracker.tsx"),
      source("../src/app/(app)/upcoming/page.tsx"),
    ]);
    assert.equal(library.match(/cv-auto focus-ring focus-ring-inset/g)?.length, 2);
    assert.equal(tracker.match(/focus-ring focus-ring-inset flex min-h-11/g)?.length, 2);
    assert.match(upcoming, /focus-ring focus-ring-inset flex min-h-11 items-center gap-3 bg-surface/);
  });
});
