import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("numerals and punctuation (JK-28)", () => {
  it("stats group digits and pluralize days", async () => {
    const stats = await source("../src/app/(app)/stats/stats-client.tsx");
    assert.match(stats, /typeof value === "number" \? formatCount\(value\) : value/);
    assert.match(stats, /`of \$\{formatCount\(stats\.episodesTotal\)\} tracked`/);
    assert.match(stats, /Longest streak:/);
    assert.doesNotMatch(stats, /\}<\/span>d\n/);
    assert.match(stats, /stats\.activeDays === 1 \? "day" : "days"/);
    assert.match(stats, /stats\.longestStreak === 1 \? "day" : "days"/);
  });

  it("uses an en dash and a real ellipsis", async () => {
    const [library, controls] = await Promise.all([
      source("../src/components/library.tsx"),
      source("../src/app/(app)/title/[id]/title-controls.tsx"),
    ]);
    assert.match(library, /"Name \(A–Z\)"/);
    assert.match(library, /\{formatCount\(filtered\.length\)\}/);
    assert.match(controls, /placeholder="Watched with…"/);
  });
});
