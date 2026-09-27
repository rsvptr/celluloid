import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The handler body of `onCloseAutoFocus={(e) => { ... }}` in a source slice. */
function closeAutoFocus(file: string): string {
  const start = file.indexOf("onCloseAutoFocus={(e) => {");
  assert.notEqual(start, -1, "onCloseAutoFocus handler not found");
  return file.slice(start, file.indexOf("}}", start));
}

// Radix's modal Content always cancels FocusScope's own focus restore and
// focuses context.triggerRef instead, which only Dialog.Trigger sets. Neither
// dialog below has a Trigger, so without these handlers focus fell to <body>
// on Cancel, Escape and confirm alike (JK-03).
describe("dialogs return focus on close (JK-03)", () => {
  it("useConfirm records the opener and focuses it again on close", async () => {
    const dialog = await source("../src/components/confirm-dialog.tsx");
    const confirmFn = dialog.slice(
      dialog.indexOf("const confirm = useCallback("),
      dialog.indexOf("const settle = useCallback("),
    );
    assert.match(confirmFn, /opener\.current =[\s\S]*document\.activeElement/);

    const handler = closeAutoFocus(dialog);
    assert.match(handler, /e\.preventDefault\(\)/);
    assert.match(handler, /isConnected[\s\S]*\.focus\(\)/);
    // A confirmed delete can remove its trigger: fall back to the page's <main>.
    assert.match(handler, /getElementById\("main"\)\?\.focus\(\)/);
  });

  it("Log watch returns focus to its button", async () => {
    const controls = await source("../src/app/(app)/title/[id]/title-controls.tsx");
    const handler = closeAutoFocus(controls);
    assert.match(handler, /e\.preventDefault\(\)/);
    assert.match(handler, /logTriggerRef\.current\?\.focus\(\)/);

    const openLog = controls.slice(
      controls.indexOf("function openLog("),
      controls.indexOf("function submitLog("),
    );
    assert.match(openLog, /logTriggerRef\.current = e\.currentTarget/);
    assert.match(controls, /onClick=\{openLog\}/);
  });
});
