import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("alignment polish (JK-36)", () => {
  it("episode rows hold the watch-through slot where dates show", async () => {
    const tracker = await source("../src/app/(app)/title/[id]/season-tracker.tsx");
    assert.match(tracker, /\{canWatchThrough \? \(\s*<button/);
    assert.match(tracker, /<span aria-hidden="true" className="hidden w-11 shrink-0 sm:block" \/>/);
  });

  it("the TMDB search spinner replaces the native clear button", async () => {
    const search = await source("../src/components/tmdb-search.tsx");
    assert.match(search, /loading && "pr-11 \[&::-webkit-search-cancel-button\]:hidden"/);
  });

  it("the custom count input matches the 32px pills", async () => {
    const rec = await source("../src/app/(app)/recommend/recommend-form.tsx");
    assert.match(rec, /className="w-20 text-center tabular-nums sm:h-8"/);
  });

  it("seven KPIs lay out 4 + 3 from sm and in one row from xl", async () => {
    const stats = await source("../src/app/(app)/stats/stats-client.tsx");
    assert.match(stats, /grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7/);
    const kpis = stats.slice(stats.indexOf("xl:grid-cols-7"), stats.indexOf("</div>", stats.indexOf("xl:grid-cols-7")));
    assert.equal(kpis.match(/<Kpi\b/g)?.length, 7);
  });
});
