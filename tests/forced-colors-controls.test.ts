import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The className string of every `type="date"` input in a file. */
function dateInputClasses(file: string): string[] {
  const classes: string[] = [];
  for (let at = file.indexOf('type="date"'); at !== -1; at = file.indexOf('type="date"', at + 1)) {
    const match = file.slice(at).match(/className="([^"]*)"/);
    assert.ok(match, "date input without a className");
    classes.push(match[1]);
  }
  return classes;
}

// Tailwind v4's outline-none is a real `outline-style: none`, and the ring-*
// focus indicator and field edge are box-shadows, which forced colors removes.
// outline-hidden emits a transparent outline under forced colors that the
// system repaints, and forced-colors:border gives fields an edge there.
describe("shared controls in forced colors (JK-02)", () => {
  it("keeps a focus indicator on Button and a focus indicator and edge on fields", async () => {
    const ui = await source("../src/components/ui.tsx");
    const buttonBase = ui.match(/const buttonBase =\s*"([^"]*)"/)?.[1] ?? "";
    const fieldBase = ui.match(/const fieldBase =\s*"([^"]*)"/)?.[1] ?? "";

    assert.match(buttonBase, /(^| )focus-visible:outline-hidden( |$)/);
    assert.match(fieldBase, /(^| )focus:outline-hidden( |$)/);
    assert.match(fieldBase, /(^| )forced-colors:border( |$)/);
    assert.doesNotMatch(ui, /outline-none/);
  });

  it("does the same for the raw date inputs", async () => {
    const files = await Promise.all([
      source("../src/app/(app)/title/[id]/title-controls.tsx"),
      source("../src/app/(app)/title/[id]/watch-history-client.tsx"),
    ]);
    const classes = files.flatMap(dateInputClasses);
    assert.equal(classes.length, 3);
    for (const cls of classes) {
      assert.match(cls, /(^| )focus:outline-hidden( |$)/);
      assert.match(cls, /(^| )forced-colors:border( |$)/);
      assert.doesNotMatch(cls, /outline-none/);
    }
  });
});
