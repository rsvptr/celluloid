import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { tmdbSize } from "../src/lib/images";

const SRC = new URL("../src/", import.meta.url);

// VE-07: TMDB images load straight from image.tmdb.org at the smallest size
// TMDB serves that covers the width the browser asks for.
describe("tmdbSize", () => {
  it("returns an exact match", () => {
    for (const w of [92, 154, 185, 342, 500, 780] as const) {
      assert.equal(tmdbSize("poster", w), `w${w}`);
    }
  });

  it("rounds up to the next size TMDB serves", () => {
    assert.equal(tmdbSize("poster", 1), "w92");
    assert.equal(tmdbSize("poster", 48), "w92");
    assert.equal(tmdbSize("poster", 93), "w154");
    assert.equal(tmdbSize("poster", 256), "w342");
    assert.equal(tmdbSize("poster", 343), "w500");
  });

  it("goes to original above w780", () => {
    assert.equal(tmdbSize("poster", 781), "original");
    assert.equal(tmdbSize("poster", 3840), "original");
  });

  it("uses each image type's own sizes", () => {
    assert.equal(tmdbSize("backdrop", 640), "w780");
    assert.equal(tmdbSize("backdrop", 828), "w1280");
    assert.equal(tmdbSize("backdrop", 1281), "original");
    assert.equal(tmdbSize("logo", 32), "w45");
    assert.equal(tmdbSize("logo", 48), "w92");
    assert.equal(tmdbSize("profile", 64), "w185");
    assert.equal(tmdbSize("profile", 186), "original");
  });

  it("never exceeds the slot's size", () => {
    // A 36px list thumbnail at 2x asks for 96: w92, not w154.
    assert.equal(tmdbSize("poster", 96, "w92"), "w92");
    assert.equal(tmdbSize("poster", 640, "w342"), "w342");
    // Below the cap, the smaller size still wins.
    assert.equal(tmdbSize("poster", 128, "w342"), "w154");
    assert.equal(tmdbSize("backdrop", 3840, "w780"), "w780");
    assert.equal(tmdbSize("logo", 48, "w45"), "w45");
    assert.equal(tmdbSize("profile", 256, "w185"), "w185");
  });
});

describe("TMDB loader wiring", () => {
  it("sets no global image loader, so local images stay optimized", async () => {
    const config = await readFile(new URL("../next.config.ts", import.meta.url), "utf8");
    assert.doesNotMatch(config, /loaderFile|\bloader\s*:/);
  });

  it("renders every TMDB image through TmdbImage", async () => {
    const entries = await readdir(SRC, { recursive: true });
    const direct: string[] = [];
    for (const file of entries.filter((entry) => /\.tsx?$/.test(entry))) {
      const text = await readFile(new URL(file, SRC), "utf8");
      if (/from "next\/image"/.test(text)) direct.push(file.replaceAll("\\", "/"));
    }
    // The loader component itself, and the two local files (logo.png and the
    // TMDB attribution SVG), which keep going through the optimizer.
    assert.deepEqual(direct.sort(), [
      "components/brand.tsx",
      "components/tmdb-attribution.tsx",
      "components/tmdb-image.tsx",
    ]);
    const brand = await readFile(new URL("components/brand.tsx", SRC), "utf8");
    assert.match(brand, /src="\/logo\.png"/);
    const attribution = await readFile(new URL("components/tmdb-attribution.tsx", SRC), "utf8");
    assert.match(attribution, /src="\/tmdb-logo\.svg"/);
  });

  it("passes the loader and a size cap on every TMDB image", async () => {
    const image = await readFile(new URL("components/tmdb-image.tsx", SRC), "utf8");
    assert.match(image, /loader=\{\(\{ width \}\) => `\$\{TMDB_IMAGE_BASE\}\$\{tmdbSize\(kind, width, maxSize\)\}\$\{path\}`\}/);
    const entries = await readdir(SRC, { recursive: true });
    let sites = 0;
    for (const file of entries.filter((entry) => entry.endsWith(".tsx"))) {
      const text = await readFile(new URL(file, SRC), "utf8");
      for (const match of text.matchAll(/<TmdbImage\b/g)) {
        const tag = text.slice(match.index, text.indexOf("/>", match.index));
        assert.match(tag, /\bkind="\w+"/, file);
        assert.match(tag, /\bmaxSize=/, file);
        sites++;
      }
    }
    // Poster, backdrop, provider logos (title page and settings), cast.
    assert.equal(sites, 5);
  });
});
