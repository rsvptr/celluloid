import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("Airing page copy", () => {
  it("formats the latest air date instead of a raw day count (JK-18)", async () => {
    const page = await source("../src/app/(app)/upcoming/page.tsx");
    assert.match(page, /`latest \$\{airedAgoText\(entry\.latestAirDateKey, todayKey\)\}`/);
    assert.doesNotMatch(page, /days ago/);
  });

  it("shows TMDB statuses through tvStatusLabel (JK-32)", async () => {
    const page = await source("../src/app/(app)/upcoming/page.tsx");
    assert.match(page, /entry\.tmdbStatus && tvStatusLabel\(entry\.tmdbStatus\)/);
  });

  it("keeps Coming up with a note when nothing is scheduled (JK-31)", async () => {
    const page = await source("../src/app/(app)/upcoming/page.tsx");
    assert.doesNotMatch(page, /groups\.length > 0 &&/);
    assert.match(page, /groups\.length === 0 && \(\s*<p[^>]*>\s*No new episodes are scheduled/);
  });

  it("gives truncated rows their full text (JK-27)", async () => {
    const page = await source("../src/app/(app)/upcoming/page.tsx");
    assert.match(page, /className="truncate text-sm font-medium" title=\{name\}/);
    assert.match(page, /className="truncate text-xs text-muted" title=\{meta\}/);
  });

  it("keeps the static to-watch count neutral, not accent (JK-17)", async () => {
    const page = await source("../src/app/(app)/upcoming/page.tsx");
    assert.match(page, /<Badge className="bg-surface-2 text-muted ring-line">\s*\{formatCount\(entry\.waiting\)\} to watch/);
  });
});
