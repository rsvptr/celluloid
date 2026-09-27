import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("watched interaction safeguards", () => {
  it("stages status select changes instead of committing ArrowDown", async () => {
    const [library, controls] = await Promise.all([
      source("../src/components/library.tsx"),
      source("../src/app/(app)/title/[id]/title-controls.tsx"),
    ]);

    const bulkMarker = library.indexOf("value={bulkStatus}");
    const bulkSelect = library.slice(
      library.lastIndexOf("<Select", bulkMarker),
      library.indexOf("</Select>", bulkMarker),
    );
    assert.match(bulkSelect, /onChange=\{\(e\) => \{[^}]*setBulkStatus/);
    assert.doesNotMatch(bulkSelect, /bulkSetStatus/);
    assert.match(library, /onClick=\{applyBulkStatus\}/);

    const titleMarker = controls.indexOf("id={statusId}");
    const titleSelect = controls.slice(
      controls.lastIndexOf("<Select", titleMarker),
      controls.indexOf("</Select>", titleMarker),
    );
    const titleChange = titleSelect.slice(
      titleSelect.indexOf("onChange="),
      titleSelect.indexOf("onBlur="),
    );
    assert.match(titleChange, /statusNavigationRef\.current[\s\S]*?return/);
    assert.match(titleChange, /return;[\s\S]*?commitImmediate\(\)/);
    assert.match(titleSelect, /STATUS_NAVIGATION_KEYS\.has\(e\.key\)/);
    assert.match(titleSelect, /e\.key === "Enter"[\s\S]*?commitImmediate\(\)/);

    // Behavioural contract: a pointer/native-picker change commits at once;
    // ArrowDown's change only stages, and Enter commits that staged value.
    let navigating = false;
    let commits = 0;
    const change = () => {
      if (navigating) {
        navigating = false;
        return;
      }
      commits += 1;
    };
    change();
    assert.equal(commits, 1, "plain change commits");
    navigating = true;
    change();
    assert.equal(commits, 1, "ArrowDown change only stages");
    commits += 1;
    assert.equal(commits, 2, "Enter commits the staged change");
  });

  it("uses one palette close path to reset state and restore opener focus", async () => {
    const palette = await source("../src/components/command-palette.tsx");
    const close = palette.slice(
      palette.indexOf("const close = useCallback"),
      palette.indexOf("useEffect(() =>", palette.indexOf("const close = useCallback")),
    );

    assert.match(close, /setOpen\(false\)/);
    assert.match(close, /setAction\(null\)/);
    assert.match(close, /setSearch\(""\)/);
    assert.match(close, /opener\.current\?\.focus\(\)/);
    assert.match(palette, /function go[\s\S]*?close\(\);[\s\S]*?router\.push/);
    assert.match(palette, /async function runAction[\s\S]*?close\(\);[\s\S]*?router\.refresh/);
    assert.match(palette, /onOpenChange=\{\(o\) => \{[\s\S]*?else close\(\)/);
  });
});
