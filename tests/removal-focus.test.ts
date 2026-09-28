import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** These files of the settings route, read as one text. */
async function settingsSource(...names: string[]) {
  const files = await Promise.all(names.map((name) => source(`../src/app/(app)/settings/${name}.tsx`)));
  return files.join("\n");
}

function between(file: string, start: string, end: string): string {
  const from = file.indexOf(start);
  assert.notEqual(from, -1, `marker not found: ${start}`);
  const to = file.indexOf(end, from);
  assert.notEqual(to, -1, `marker not found: ${end}`);
  return file.slice(from, to);
}

/** The element carrying `id="<id>"`, from its opening `<` to the end of its tag. */
function elementWithId(file: string, id: string): string {
  const at = file.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `no element with id ${id}`);
  return file.slice(file.lastIndexOf("<", at), file.indexOf(">", at) + 1);
}

// A successful action that removes the control that had focus (a deleted row,
// a panel that swaps) used to leave focus on <body> (review-p1-focus-forms.md,
// issue 7). Each now moves focus somewhere sensible that exists afterwards.
describe("focus after an action removes its own control", () => {
  it("deleted rows hand focus to their section's heading", async () => {
    const settings = await settingsSource("settings-ui", "shared-links-section", "tags-section", "devices-section");
    const heading = between(settings, "function Section(", "function Notice(");
    assert.match(heading, /id=\{headingId\}\s+tabIndex=\{headingId \? -1 : undefined\}/);

    for (const [handler, end, success, id] of [
      ["async function remove(id: string, active: boolean)", "return (", 'toast.success("Link deleted");', "settings-shared-links-heading"],
      ["async function remove(tag: TagSummary)", "return (", "toast.success(`Deleted the", "settings-tags-heading"],
      ["async function revokeSession(", "async function revokeOtherSessions()", "toast.success(`${label} signed out`);", "settings-devices-heading"],
    ] as const) {
      const body = between(settings, handler, end);
      const after = body.slice(body.indexOf(success));
      assert.match(
        after,
        new RegExp(`^[^\\n]*\\n(?:\\s*//[^\\n]*\\n)*\\s*document\\.getElementById\\("${id}"\\)\\?\\.focus\\(\\);`),
        `${handler}: focus doesn't move on success`,
      );
      assert.match(settings, new RegExp(`headingId="${id}"`), `${id}: no such heading`);
    }
  });

  it("removing the API key hands focus to the key field", async () => {
    const section = await source("../src/app/(app)/settings/api-key-section.tsx");
    const body = between(section, "async function removeKey()", "return (");
    const after = body.slice(body.indexOf('setStatus("Personal API key removed.");'));
    assert.match(
      after,
      /^[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*document\.getElementById\("settings-anthropic-api-key"\)\?\.focus\(\);/,
      "focus doesn't move on success",
    );
    // Only on success: a failed removal keeps the Remove button, and its focus.
    assert.ok(body.indexOf("setError(result.error);") < body.indexOf("setSaved(false);"));
    assert.match(elementWithId(section, "settings-anthropic-api-key"), /^<Input/);
  });

  it("the 2FA panel swaps move focus into the panel that replaces them", async () => {
    const settings = await source("../src/app/(app)/settings/two-factor-section.tsx");
    for (const [handler, end, state, id] of [
      ["async function beginEnable()", "async function confirmEnable()", 'setPhase("setup");', "settings-two-factor-setup-start"],
      ["async function confirmEnable()", "async function disable()", "setOn(true);", "settings-two-factor-on"],
      ["async function disable()", "return (", "setOn(false);", "settings-enable-two-factor-password"],
    ] as const) {
      const body = between(settings, handler, end);
      // The swap renders before focus moves, so the target exists.
      const flush = body.slice(body.indexOf("flushSync(() => {"), body.indexOf("});", body.indexOf("flushSync(() => {")));
      assert.ok(flush.includes(state), `${handler}: ${state} isn't flushed`);
      assert.match(
        body.slice(body.indexOf(state)),
        new RegExp(`\\}\\);\\s*document\\.getElementById\\("${id}"\\)\\?\\.focus\\(\\);`),
        `${handler}: focus doesn't follow the flush`,
      );
    }
    // Step 1 of setup and the "on" status are focusable without joining the tab order.
    assert.match(elementWithId(settings, "settings-two-factor-setup-start"), /tabIndex=\{-1\}/);
    assert.match(elementWithId(settings, "settings-two-factor-on"), /tabIndex=\{-1\}/);
    assert.match(elementWithId(settings, "settings-enable-two-factor-password"), /^<Input/);
  });

  it("a restore hands focus to its result once the preview is gone", async () => {
    const settings = await settingsSource("backup-section", "settings-ui");
    const body = between(settings, "async function commitRestore()", "return (");
    assert.match(
      body,
      /flushSync\(\(\) => \{\s*setResult\(restored\);\s*setPreview\(null\);\s*\}\);\s*document\.getElementById\("settings-restore-result"\)\?\.focus\(\);/,
    );
    assert.match(settings, /<Notice kind="ok" focusId="settings-restore-result">/);
    const notice = between(settings, "function Notice(", "async function copyText(");
    assert.match(notice, /id=\{focusId\}\s+tabIndex=\{focusId \? -1 : undefined\}/);
  });
});
