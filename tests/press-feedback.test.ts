import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui";

const SRC = new URL("../src/", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, SRC), "utf8");
}

/** The body of `@utility press { … }`, nested braces included. */
function pressUtility(css: string): string {
  const start = css.indexOf("@utility press {");
  assert.notEqual(start, -1, "globals.css has no @utility press");
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error("unterminated @utility press");
}

// EM-01: emil-design-eng press feedback, scale 0.97 over 160 ms on emil's
// ease-out, never on disabled controls or under reduced motion.
describe("press feedback (EM-01)", () => {
  it("defines the press utility with emil's values", async () => {
    const press = pressUtility(await source("app/globals.css"));
    assert.match(press, /transition-duration: 160ms;/);
    // emil's cubic-bezier(0.23, 1, 0.32, 1), from the motion tokens (EM-14).
    assert.match(press, /transition-timing-function: var\(--ease-out\);/);
    // Keeps everything transition-colors covered, and adds opacity and scale.
    assert.match(
      press,
      /transition-property: color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, scale;/,
    );
    assert.match(
      press,
      /@media \(prefers-reduced-motion: no-preference\) \{\s*&:active:not\(:disabled, \[aria-disabled="true"\]\) \{\s*scale: 0\.97;\s*\}\s*\}/,
    );
    // Scale only: no transform (Tailwind positions with `translate`), and no
    // box-shadow, so focus rings still switch instantly.
    assert.doesNotMatch(press, /transform|box-shadow/);
  });

  it("gives every Button press feedback", () => {
    const html = renderToStaticMarkup(createElement(Button, null, "Save"));
    const classes = html.match(/class="([^"]*)"/)?.[1].split(" ") ?? [];
    assert.ok(classes.includes("press"));
    assert.ok(!classes.includes("transition-colors"));
  });

  it("never pairs press with another transition utility", async () => {
    const entries = await readdir(SRC, { recursive: true });
    let count = 0;
    for (const entry of entries.filter((e) => e.endsWith(".tsx"))) {
      const text = await readFile(new URL(entry, SRC), "utf8");
      for (const [, classes] of text.matchAll(/"([^"\n]*\bpress\b[^"\n]*)"/g)) {
        count++;
        assert.doesNotMatch(
          classes,
          /(^| )(transition(-[\w[\]-]+)?|duration-\S+|ease-\S+|scale-\S+)( |$)/,
          `${entry}: press sets its own transition and scale`,
        );
      }
    }
    assert.ok(count > 0);
  });

  it("tints full-width episode rows instead of scaling them", async () => {
    const tracker = await source("app/(app)/title/[id]/season-tracker.tsx");
    const row = tracker.match(/className="(focus-ring focus-ring-inset flex min-h-11 flex-1 [^"]*)"/)?.[1] ?? "";
    assert.match(row, /(^| )active:bg-surface-2\/60( |$)/);
    assert.doesNotMatch(row, /(^| )press( |$)/);
  });

  it("presses the rest of the library toolbar and Add title", async () => {
    const library = (await Promise.all(["library", "library-toolbar", "library-bulk-bar"].map((name) => source(`components/${name}.tsx`)))).join("\n");
    const classOf = (anchor: string) => {
      const at = library.indexOf(anchor);
      assert.notEqual(at, -1, anchor);
      return library.slice(at).match(/"(focus-ring [^"]*|inline-flex [^"]*)"/)?.[1] ?? "";
    };
    for (const anchor of [
      "const addTitleButtonClass",
      'aria-label="Select titles"',
      'aria-label="Surprise me"',
      'aria-label="Share your library"',
      'aria-controls="bulk-more-actions"',
      "function ViewToggle(",
    ]) {
      const classes = classOf(anchor);
      assert.match(classes, /(^| )press( |$)/, anchor);
      assert.doesNotMatch(classes, /(^| )transition-colors( |$)/, anchor);
    }
  });

  it("tints library list rows instantly instead of scaling them", async () => {
    const library = await source("components/library-results.tsx");
    const rows = [...library.matchAll(/"(cv-auto focus-ring focus-ring-inset flex items-center gap-3 [^"]*)"/g)];
    assert.equal(rows.length, 2);
    for (const [, row] of rows) {
      // duration-0, not transition-none: reduced motion (globals.css) sets
      // transition-property, which would bring a fade back.
      assert.match(row, /(^| )active:bg-surface-2\/60 active:duration-0( |$)/);
      assert.doesNotMatch(row, /(^| )press( |$)/);
    }
  });
});
