import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("Add buttons name the type and year (JK-21)", () => {
  it("Add search passes the qualified name to every label", async () => {
    const add = await source("../src/app/(app)/add/add-search.tsx");
    assert.match(add, /name=\{nameWithTypeAndYear\(r\.name, r\.mediaType, r\.year\)\}/);
  });

  it("More like this passes the year to QuickAdd", async () => {
    const [extras, client] = await Promise.all([
      source("../src/app/(app)/title/[id]/title-extras.tsx"),
      source("../src/app/(app)/title/[id]/title-extras-client.tsx"),
    ]);
    assert.match(extras, /<QuickAdd[^>]*year=\{year\}/);
    assert.match(client, /aria-label=\{`Add \$\{nameWithTypeAndYear\(name, mediaType, year\)\} to your watchlist`\}/);
  });

  it("recommendations qualify Add and View", async () => {
    const rec = await source("../src/app/(app)/recommend/recommend-client.tsx");
    assert.match(rec, /`Add \$\{nameWithTypeAndYear\(rec\.title, rec\.mediaType, rec\.year\)\} to your watchlist`/);
    assert.match(rec, /`View \$\{nameWithTypeAndYear\(rec\.title, rec\.mediaType, rec\.year\)\} in your watchlist`/);
  });
});
