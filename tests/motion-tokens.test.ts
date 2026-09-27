import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { EASE_DRAWER, EASE_OUT } from "../src/components/motion";

const SRC = new URL("../src/", import.meta.url);

async function sources(ext: RegExp) {
  const entries = await readdir(SRC, { recursive: true });
  return Promise.all(
    entries
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => ext.test(entry))
      .map(async (file) => ({ file, text: await readFile(new URL(file, SRC), "utf8") })),
  );
}

/** globals.css's motion token block. */
async function tokenBlock() {
  const css = await readFile(new URL("app/globals.css", SRC), "utf8");
  const start = css.indexOf("@theme static {");
  assert.notEqual(start, -1, "globals.css has no @theme static motion token block");
  return { css, block: css.slice(start, css.indexOf("}", start) + 1) };
}

const bezier = (points: readonly number[]) => `cubic-bezier(${points.join(", ")})`;

// EM-14: one definition per curve, emil-design-eng's values.
describe("motion tokens (EM-14)", () => {
  it("defines emil's curves once in CSS, and Motion's copies match", async () => {
    const { block } = await tokenBlock();
    assert.deepEqual([...EASE_OUT], [0.23, 1, 0.32, 1]);
    assert.deepEqual([...EASE_DRAWER], [0.32, 0.72, 0, 1]);
    assert.ok(block.includes(`--ease-out: ${bezier(EASE_OUT)};`));
    assert.ok(block.includes(`--ease-drawer: ${bezier(EASE_DRAWER)};`));
  });

  it("types no curve outside the tokens", async () => {
    const { css, block } = await tokenBlock();
    assert.doesNotMatch(css.replace(block, ""), /cubic-bezier\(/);
    for (const { file, text } of await sources(/\.tsx?$/)) {
      assert.doesNotMatch(text, /cubic-bezier\(/, `${file}: use var(--ease-out) or ease-out`);
      assert.doesNotMatch(text, /ease: \[/, `${file}: use EASE_OUT or EASE_DRAWER`);
      // The keyword is Tailwind's weak default curve, not the token.
      assert.doesNotMatch(text, /_ease-out\]/, `${file}: use var(--ease-out)`);
    }
  });
});
