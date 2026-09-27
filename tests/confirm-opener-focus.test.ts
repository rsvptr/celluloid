import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The `<Button ...>...</Button>` that contains `marker`. */
function buttonAround(file: string, marker: string): string {
  const at = file.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  return file.slice(file.lastIndexOf("<Button", at), file.indexOf("</Button>", at));
}

function assertSoftDisabled(button: string, marker: string) {
  const condition = button.match(/aria-disabled=\{([^}]*)\}/)?.[1];
  assert.ok(condition, `${marker}: no aria-disabled`);
  assert.doesNotMatch(button, /\sdisabled=\{/, `${marker}: still natively disabled`);
  assert.match(button, /softDisabledClass/, `${marker}: no soft-disabled styling`);
  // Click, Enter and Space all arrive as a click, so the handler must refuse
  // while the button is soft-disabled.
  assert.ok(button.includes(`if (${condition}) return;`), `${marker}: handler not guarded`);
}

// useConfirm hands focus back to its opener after the dialog closes, but a
// confirmed action that natively disables the opener has already moved focus
// to <body> by then (review-a11y-p0.md, JK-03 minor). These openers use the
// JK-08 aria-disabled pattern instead.
describe("confirm openers keep focus after confirming (JK-03)", () => {
  it("settings openers soft-disable", async () => {
    const settings = await source("../src/app/(app)/settings/settings-client.tsx");
    for (const marker of [
      "{pendingAction === `revoke:",
      "{pendingAction === `delete:",
      '{deleting ? "Deleting…"',
      "void revokeSession(session)",
      "void revokeOtherSessions()",
      "void disable()",
      "void commitRestore()",
      "Delete my account",
    ]) {
      assertSoftDisabled(buttonAround(settings, marker), marker);
    }
  });

  it("Empty trash and Cancel import soft-disable", async () => {
    const library = await source("../src/components/library.tsx");
    assertSoftDisabled(buttonAround(library, "void purgeAll()"), "Empty trash");
    const review = await source("../src/components/import-review.tsx");
    assertSoftDisabled(buttonAround(review, "void cancel()"), "Cancel import");
  });
});
