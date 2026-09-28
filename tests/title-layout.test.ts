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

describe("title page hero (JK-15)", () => {
  it("lets a long unbreakable title wrap instead of clipping", async () => {
    const page = await source("../src/app/(app)/title/[id]/page.tsx");
    // The column after the poster is a row flex item from sm up: without
    // min-w-0 it grows to the title's width and the hero clips it.
    const poster = page.indexOf('<div className="w-32 shrink-0 sm:w-44">');
    assert.notEqual(poster, -1);
    const column = page.slice(page.indexOf("</div>", poster)).match(/<div className="([^"]*)">/)?.[1];
    assert.equal(column, "flex min-w-0 flex-col gap-3");
    const h1 = page.match(/<h1 className="([^"]*)">\s*\{title\.name\}/)?.[1].split(" ") ?? [];
    assert.ok(h1.includes("break-words"), h1.join(" "));
    assert.ok(h1.includes("text-balance"), h1.join(" "));
  });
});

describe("title page backdrop (P7U-7)", () => {
  it("reads backdropPath directly, with no leftover alias", async () => {
    const page = await source("../src/app/(app)/title/[id]/page.tsx");
    assert.doesNotMatch(page, /const backdrop = /);
    assert.match(page, /\{title\.backdropPath && \(\s*<div className="absolute inset-0">\s*<TmdbImage\s+path=\{title\.backdropPath\}/);
    assert.match(page, /lcp=\{title\.backdropPath \? "eager" : "preload"\}/);
  });
});

describe("title page TMDB request", () => {
  it("starts one bundle request and shares it with everything drawn from TMDB", async () => {
    const [page, extras, releases] = await Promise.all([
      source("../src/app/(app)/title/[id]/page.tsx"),
      source("../src/app/(app)/title/[id]/title-extras.tsx"),
      source("../src/app/(app)/title/[id]/regional-releases.tsx"),
    ]);
    assert.equal(page.match(/getTitleBundle\(/g)?.length, 1);
    assert.doesNotMatch(extras, /getTitleBundle\(/);
    assert.doesNotMatch(releases, /getTitleBundle\(/);
    assert.match(page, /<TitleExtras[^>]*bundle=\{bundle\}/);
    // Regional release dates: watchlisted films only, streamed in so the hero
    // never waits on TMDB.
    assert.match(
      page,
      /!isTv && title\.status === "WATCHLIST" && \(\s*<Suspense fallback=\{null\}>\s*<RegionalReleases bundle=\{bundle\} region=\{region\} \/>/,
    );
  });
});
