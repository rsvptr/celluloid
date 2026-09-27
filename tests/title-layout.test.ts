import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("title page grid (JK-04)", () => {
  it("moves extras into the tracker's rows on movies and leaves TV unchanged", async () => {
    const page = await source("../src/app/(app)/title/[id]/page.tsx");
    const extras = page.slice(
      page.lastIndexOf("<div", page.indexOf("<TitleExtrasFallback")),
      page.indexOf("<TitleExtrasFallback"),
    );
    assert.match(
      extras,
      /isTv \? "lg:row-start-3" : "lg:row-start-1 lg:row-span-2"/,
    );
    // The mobile order and the lg column placement stay as they were.
    assert.match(extras, /order-4 flex flex-col gap-6 lg:order-none lg:col-span-2 lg:col-start-1/);

    // The tracker still owns rows 1-2 on TV.
    const tracker = page.slice(page.indexOf("{isTv && ("), page.indexOf("<SeasonTracker"));
    assert.match(tracker, /lg:col-start-1 lg:row-start-1 lg:row-span-2/);
  });
});
