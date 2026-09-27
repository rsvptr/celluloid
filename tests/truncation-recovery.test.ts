import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("truncated text stays recoverable (JK-27)", () => {
  it("list, Trash and tag chips carry a title", async () => {
    const library = (await Promise.all(["library-results", "library-trash"].map((name) => source(`../src/components/${name}.tsx`)))).join("\n");
    assert.match(library, /<span className="truncate text-sm font-medium" title=\{item\.name\}>/);
    assert.match(library, /<div className="truncate text-sm font-medium" title=\{item\.name\}>/);
    assert.match(library, /key=\{t\}\s+title=\{t\}/);
  });

  it("episode names carry a title", async () => {
    const tracker = await source("../src/app/(app)/title/[id]/season-tracker.tsx");
    assert.match(tracker, /"min-w-0 flex-1 truncate text-sm",[\s\S]{0,200}title=\{ep\.name \?\? undefined\}/);
  });

  it("settings share names and shared titles carry a title", async () => {
    const settings = await source("../src/app/(app)/settings/settings-client.tsx");
    assert.match(settings, /title=\{s\.name \?\? undefined\}/);
    assert.match(settings, /truncate text-foreground\/90" title=\{t\.name\}/);
  });

  it("a long share-page note can be expanded without client JS", async () => {
    const share = await source("../src/app/s/[slug]/page.tsx");
    assert.match(share, /line-clamp-4 [^"]*group-has-\[details\[open\]\]\/note:line-clamp-none/);
    assert.match(share, /noteMayClamp\(item\.notes\) \? \(\s*<details/);
    assert.match(share, /Show full note/);
  });
});
