import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, SRC), "utf8");
}

// The smaller emil-design-eng items (EM-10 to EM-17) and the review nits.
describe("motion polish", () => {
  it("closes the More popover faster than it opens (EM-10)", async () => {
    const nav = await source("components/nav.tsx");
    const popover = nav.slice(nav.indexOf('id="nav-more-menu"'), nav.indexOf("className=", nav.indexOf('id="nav-more-menu"')));
    assert.match(popover, /exit=\{\{[^}]*transition: \{ duration: 0\.1, ease: EASE_OUT \},\s*\}\}/);
    assert.match(popover, /\}\}\s*transition=\{\{ duration: 0\.15, ease: EASE_OUT \}\}/);
  });

  it("measures the nav pill to the sub-pixel, like the static pill", async () => {
    const nav = await source("components/nav.tsx");
    const measure = nav.slice(nav.indexOf("const measure = () =>"), nav.indexOf("measure();"));
    assert.doesNotMatch(measure, /link\.offset/);
    assert.match(measure, /x: box\.left - nav\.getBoundingClientRect\(\)\.left, width: box\.width/);
  });
});
