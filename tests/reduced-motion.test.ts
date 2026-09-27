import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const SRC = new URL("../src/", import.meta.url);

/** The body of globals.css's `@media (prefers-reduced-motion: reduce)` block. */
async function reducedBlock(): Promise<string> {
  const css = await readFile(new URL("app/globals.css", SRC), "utf8");
  const start = css.indexOf("@media (prefers-reduced-motion: reduce) {");
  assert.notEqual(start, -1, "globals.css has no reduced-motion block");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unterminated reduced-motion block");
}

/** The declarations of the rule whose selector list starts with `selector`. */
function rule(block: string, selector: string): string {
  const start = block.indexOf(selector);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  return block.slice(block.indexOf("{", start) + 1, block.indexOf("}", start));
}

// EM-04: reduced motion keeps fades and colour, drops movement, stops loops,
// and still refuses any CSS animation nobody has explicitly allowed.
describe("reduced motion (EM-04)", () => {
  it("keeps a kill switch for every CSS animation, loops included", async () => {
    const all = rule(await reducedBlock(), "*,\n  *::before,\n  *::after");
    assert.match(all, /animation-duration: 0\.001ms !important;/);
    assert.match(all, /animation-iteration-count: 1 !important;/);
  });

  it("keeps transition durations but drops movement", async () => {
    const all = rule(await reducedBlock(), "*,\n  *::before,\n  *::after");
    assert.doesNotMatch(all, /transition-duration/);
    const properties = all.match(/transition-property: ([^;]*) !important;/)?.[1].split(", ") ?? [];
    for (const kept of ["color", "background-color", "border-color", "opacity", "box-shadow"]) {
      assert.ok(properties.includes(kept), kept);
    }
    for (const property of properties) {
      assert.doesNotMatch(property, /transform|translate|scale|rotate|width|height|inset|top|left|grid|all/);
    }
  });

  it("allows only the dialog fades and the spinner pulse", async () => {
    const block = await reducedBlock();
    assert.match(rule(block, '.dialog-overlay[data-state="open"]'), /animation-duration: var\(--duration-dialog-in\) !important;/);
    assert.match(rule(block, '.dialog-overlay[data-state="closed"]'), /animation-duration: var\(--duration-dialog-out\) !important;/);
    // The content fades like the overlay, without its scale.
    assert.match(block, /\.dialog-content\[data-state="open"\] \{\s*animation-name: dialog-overlay-in;/);
    assert.match(block, /\.dialog-content\[data-state="closed"\] \{\s*animation-name: dialog-overlay-out;/);
    assert.match(rule(block, ".animate-spin"), /animation: spinner-pulse 1s ease-in-out infinite alternate !important;/);
    // Nothing else opts back in.
    assert.equal(block.match(/infinite/g)?.length, 1);
    assert.equal(block.match(/animation-duration: var/g)?.length, 2);
  });

  it("lets Motion handle the filter panel without a bespoke branch", async () => {
    const library = (await Promise.all(["library", "library-toolbar", "library-filter-panel", "library-results", "library-bulk-bar", "library-trash", "library-filters-context"].map((name) => readFile(new URL(`components/${name}.tsx`, SRC), "utf8")))).join("\n");
    assert.doesNotMatch(library, /useReducedMotion|reduceMotion/);
  });
});
