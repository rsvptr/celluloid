import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The `<form ...>...</form>` that encloses `marker`. */
function formAround(file: string, marker: string): string {
  const at = file.indexOf(marker);
  assert.notEqual(at, -1, `marker not found: ${marker}`);
  const start = file.lastIndexOf("<form", at);
  assert.notEqual(start, -1, `${marker}: not in a form`);
  assert.equal(file.lastIndexOf("</form>", at) < start, true, `${marker}: not in a form`);
  return file.slice(start, file.indexOf("</form>", at));
}

/** Enter in a field submits through onSubmit, and the primary button submits
 * rather than running its own onClick. */
function assertSubmits(file: string, label: string) {
  const form = formAround(file, label);
  assert.match(form, /onSubmit=\{(async )?\(e\) => \{\s*e\.preventDefault\(\);/, `${label}: no onSubmit`);
  // form.requestSubmit() (some password managers' fill-and-submit) skips the
  // disabled-default-button check, so onSubmit refuses on its own.
  assert.match(form, /e\.preventDefault\(\);\s*if \(.+\) return;/, `${label}: onSubmit not guarded`);
  const at = form.indexOf(label);
  const button = form.slice(form.lastIndexOf("<Button", at), at);
  assert.match(button, /type="submit"/, `${label}: not a submit button`);
  assert.doesNotMatch(button, /onClick=/, `${label}: submits through onClick`);
}

// Loose inputs with onClick buttons meant Enter did nothing and password
// managers saw no form (JK-11).
describe("panels submit as forms (JK-11)", () => {
  it("settings: profile, API key, password, 2FA and delete account", async () => {
    const settings = await source("../src/app/(app)/settings/settings-client.tsx");
    for (const label of [
      // Profile's Save (the first at this indent; Preferences' Save follows).
      "Save\n        </Button>",
      '{saved ? "Replace key" : "Save key"}',
      '{pending ? "Updating…" : "Change password"}',
      ": null} Turn off 2FA",
      "<ShieldCheck size={16} />} Enable 2FA",
      ": null} Verify & turn on",
      "<Trash2 size={16} /> Delete my account",
    ]) {
      assertSubmits(settings, label);
    }

    const password = formAround(settings, '{pending ? "Updating…" : "Change password"}');
    assert.match(password, /autoComplete="current-password"/);
    assert.match(password, /autoComplete="new-password"/);
  });

  it("Log watch, share and watch history edit", async () => {
    const controls = await source("../src/app/(app)/title/[id]/title-controls.tsx");
    assertSubmits(controls, '{isLogging ? "Logging…" : "Log watch"}');

    const history = await source("../src/app/(app)/title/[id]/watch-history-client.tsx");
    assertSubmits(history, "<Check size={16} /> Save");

    const share = await source("../src/components/share-dialog.tsx");
    assertSubmits(share, '{pending ? "Creating…" : "Create link"}');
    // Chrome and Firefox submit on Enter in a checkbox; that must not publish.
    const form = formAround(share, "Create link");
    const checkboxes = form.split('type="checkbox"').slice(1);
    assert.equal(checkboxes.length, 2);
    for (const box of checkboxes) {
      assert.match(box.slice(0, box.indexOf("/>")), /if \(e\.key === "Enter"\) e\.preventDefault\(\);/);
    }
    // The result phase (Copy, Done) stays outside the form.
    assert.equal(share.indexOf("ref={resultActionRef}") > share.lastIndexOf("</form>"), true);
  });
});
