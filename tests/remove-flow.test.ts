import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The `<Button ...>...</Button>` whose children end with `label`. */
function buttonLabelled(file: string, label: RegExp): string {
  const at = file.search(label);
  assert.notEqual(at, -1, `label not found: ${label}`);
  return file.slice(file.lastIndexOf("<Button", at), at);
}

// EM-18 (owner decision): a single remove goes straight to Trash with an Undo
// toast; only a bulk remove still asks first.
describe("remove flow (EM-18)", () => {
  it("removes a single title without confirming, then offers Undo", async () => {
    const controls = await source("../src/app/(app)/title/[id]/title-controls.tsx");
    assert.doesNotMatch(controls, /from "@\/components\/confirm-dialog"|\bconfirm\(\{/);
    const remove = buttonLabelled(controls, /<Trash2 size=\{\d+\} \/>\s*Remove\n/);
    assert.match(remove, /await removeTitle\(id\)/);
    assert.match(remove, /undoToast\("Moved to Trash", \{\s*undo: \(\) => restoreTitle\(id\)/);
    // One remove per click burst, released again when it fails or is undone.
    assert.match(remove, /if \(removingRef\.current\) return;\s*removingRef\.current = true;/);
    assert.equal(remove.match(/removingRef\.current = false;/g)?.length, 3);
    assert.match(remove, /onSuccess: \(\) => \{\s*removingRef\.current = false;\s*router\.push\(`\/title\/\$\{id\}`\);/);
    // The button leaves with the page; focus goes to the persistent <main>.
    assert.match(remove, /router\.push\("\/"\);[\s\S]*getElementById\("main"\)\?\.focus\(\)/);
  });

  it("still confirms a bulk remove", async () => {
    const library = await source("../src/components/library-bulk-bar.tsx");
    const remove = buttonLabelled(library, /<Trash2 size=\{\d+\} \/> Remove\n/);
    assert.match(remove, /await confirm\(\{[\s\S]*confirmLabel: "Remove"[\s\S]*removeSelected\(\)/);
  });
});
