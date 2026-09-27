import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The body of the first `selector { … }` rule in `css`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

// VE-05: the browser skips layout and paint for library cards and rows that are
// off screen. The containment sits where it can't clip a focus ring or a
// press transform.
describe("content-visibility on library cards and rows (VE-05)", () => {
  it("defines both helpers with a remembered intrinsic size", async () => {
    const css = await source("../src/app/globals.css");
    const row = rule(css, ".cv-auto");
    assert.match(row, /content-visibility: auto;/);
    assert.match(row, /contain-intrinsic-size: auto \d+px;/);
    const card = rule(css, ".cv-auto-card");
    assert.match(card, /content-visibility: auto;/);
    assert.match(card, /contain-intrinsic-size: auto \d+px auto \d+px;/);
  });

  it("contains the card's visual, not the link that scales and takes focus", async () => {
    const card = await source("../src/components/title-card.tsx");
    const visual = card.slice(card.indexOf("const visual = ("), card.indexOf("<div className=\"relative\">"));
    assert.match(visual, /"cv-auto-card"/);
    // Room for the hover and selection ring, which paint containment would clip.
    assert.match(visual, /"-mx-0\.5 -mt-0\.5 px-0\.5 pt-0\.5"/);
    const press = card.match(/const pressClass =\s*"([^"]*)"/)?.[1] ?? "";
    assert.match(press, /active:scale-\[0\.98\]/);
    assert.doesNotMatch(press, /cv-auto/);
    assert.equal(card.match(/cv-auto/g)?.length, 1);
  });

  it("gives every list row an inset focus ring, since the row contains paint", async () => {
    const results = await source("../src/components/library-results.tsx");
    const rows = results.match(/"cv-auto [^"]*"/g) ?? [];
    assert.equal(rows.length, 2);
    for (const row of rows) assert.match(row, /\bfocus-ring focus-ring-inset\b/);
  });
});
