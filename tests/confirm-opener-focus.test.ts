import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The `<Button ...>...</Button>` that contains `marker`, and its handler's
 * scope: the button itself, or for a submit button, its form up to the button. */
function buttonAround(file: string, marker: string): { button: string; handler: string } {
  const at = file.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  const start = file.lastIndexOf("<Button", at);
  const button = file.slice(start, file.indexOf("</Button>", at));
  const handler = button.includes('type="submit"')
    ? file.slice(file.lastIndexOf("<form", start), start)
    : button;
  return { button, handler };
}

function assertSoftDisabled({ button, handler }: { button: string; handler: string }, marker: string) {
  const condition = button.match(/aria-disabled=\{([^}]*)\}/)?.[1];
  assert.ok(condition, `${marker}: no aria-disabled`);
  assert.doesNotMatch(button, /\sdisabled=\{/, `${marker}: still natively disabled`);
  assert.match(button, /softDisabledClass/, `${marker}: no soft-disabled styling`);
  // Click, Enter and Space all arrive as a click (and a submit button's click,
  // or Enter in a field, as a submit), so the handler must refuse while the
  // button is soft-disabled.
  assert.ok(handler.includes(`if (${condition}) return;`), `${marker}: handler not guarded`);
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
      ": null} Turn off 2FA",
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
