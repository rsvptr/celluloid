import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

// VE-04: search re-renders Library on every keystroke. Like TitleCard in grid
// view, list rows are memoized, which only holds while each prop keeps its
// identity between those renders.
describe("library list rows (VE-04)", () => {
  it("memoizes ListRow and hands it only stable props", async () => {
    const library = await source("../src/components/library.tsx");
    assert.match(library, /const ListRow = memo\(function ListRow\(/);

    const at = library.indexOf("<ListRow");
    const row = library.slice(at, library.indexOf("/>", at));
    assert.match(row, /item=\{it\}/);
    assert.match(row, /tagColors=\{tagColors\}/);
    assert.match(row, /selectMode=\{selectMode\}/);
    assert.match(row, /selected=\{selected\.has\(it\.id\)\}/);
    assert.match(row, /onToggle=\{toggle\}/);
    // No inline callback or object literal, which would be new every render.
    assert.doesNotMatch(row, /=\{\(|=\{\{/);

    // The callback is created once.
    assert.match(
      library,
      /const toggle = useCallback\(\(id: string\) => \{[\s\S]*?\n {2}\}, \[\]\);/,
    );
  });

  it("prefetches rows on intent, not on viewport entry (VE-06)", async () => {
    const library = await source("../src/components/library.tsx");
    const start = library.indexOf("const ListRow = memo(function ListRow(");
    const listRow = library.slice(start, library.indexOf("\n});", start));
    // The href is built inside the row, so no new prop reaches the memo.
    assert.match(listRow, /<IntentLink\s+href=\{`\/title\/\$\{item\.id\}`\}/);
    assert.doesNotMatch(listRow, /<Link\b/);
  });
});
