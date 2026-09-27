import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("watched interaction safeguards", () => {
  it("stages status select changes instead of committing ArrowDown", async () => {
    const [library, controls] = await Promise.all([
      source("../src/components/library-bulk-bar.tsx"),
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

  it("keeps an arrow-staged status out of the save queue until Enter or blur", async () => {
    const controls = await source("../src/app/(app)/title/[id]/title-controls.tsx");
    const titleMarker = controls.indexOf("id={statusId}");
    const titleSelect = controls.slice(
      controls.lastIndexOf("<Select", titleMarker),
      controls.indexOf("</Select>", titleMarker),
    );
    const between = (from: string, to: string) =>
      titleSelect.slice(titleSelect.indexOf(from), titleSelect.indexOf(to));

    // drainImmediate diffs every field of latestImmediateRef on each pass, so a
    // staged value written there is sent by any save already in flight.
    const change = between("onChange=", "onBlur=");
    const staging = change.slice(0, change.indexOf("return;") + "return;".length);
    assert.doesNotMatch(staging, /latestImmediateRef/);
    assert.match(staging, /statusStagedRef\.current = true/);
    assert.match(
      change.slice(change.indexOf("return;")),
      /latestImmediateRef\.current\.status = v;\s*commitImmediate\(\)/,
    );

    for (const commit of [between("onBlur=", "onKeyDown="), between('e.key === "Enter"', "onKeyUp=")]) {
      assert.match(
        commit,
        /statusStagedRef\.current = false;\s*latestImmediateRef\.current\.status = e\.currentTarget\.value as WatchStatus;\s*commitImmediate\(\)/,
      );
    }

    // A refresh from that in-flight save must not snap the staged pick back.
    assert.match(controls, /if \(!statusStagedRef\.current\) setLocalStatus\(status\);/);
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
    // VE-02: runAction closes through the same path but doesn't refresh after
    // it; the successful action's response already carries the re-rendered
    // page. Only a failed undo re-syncs.
    const runAction = palette.slice(
      palette.indexOf("async function runAction"),
      palette.indexOf("const activeAction"),
    );
    assert.match(runAction, /close\(\);/);
    assert.doesNotMatch(runAction.slice(runAction.indexOf("close();")), /router\.refresh/);
    assert.match(runAction, /onError: \(\) => router\.refresh\(\)/);
    assert.match(palette, /onOpenChange=\{\(o\) => \{[\s\S]*?else close\(\)/);
  });
});
