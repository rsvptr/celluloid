import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The JSX of the element that renders `label`, back to its opening tag. */
function elementBefore(text: string, label: string, tag: string) {
  const end = text.indexOf(label);
  assert.ok(end > 0, `no ${label}`);
  return text.slice(text.lastIndexOf(`<${tag}`, end), end);
}

// APG button pattern: a toggle keeps one label and exposes aria-pressed; an
// action button whose label names the next action has no aria-pressed.
describe("toggle buttons pick one state carrier (JK-06)", () => {
  it("the show and season buttons are actions, not toggles", async () => {
    const tracker = await source("../src/app/(app)/title/[id]/season-tracker.tsx");
    assert.doesNotMatch(elementBefore(tracker, '"Mark all unwatched"', "Button"), /aria-pressed=/);
    assert.doesNotMatch(elementBefore(tracker, '"Mark season unwatched"', "button"), /aria-pressed=/);
  });

  it("Favorite keeps its label and exposes aria-pressed", async () => {
    const controls = await source("../src/app/(app)/title/[id]/title-controls.tsx");
    assert.doesNotMatch(controls, /"Favorited"/);
    assert.match(elementBefore(controls, "Favorite\n", "Button"), /aria-pressed=\{localFav\}/);
  });

  it("the password reveal keeps one name", async () => {
    const form = await source("../src/app/login/auth-form.tsx");
    assert.match(form, /aria-label="Show password"\s+aria-pressed=\{showPassword\}/);
    assert.doesNotMatch(form, /aria-label=\{showPassword/);
  });

  it("import review's select button names the action without aria-pressed", async () => {
    const review = await source("../src/components/import-review.tsx");
    assert.doesNotMatch(elementBefore(review, '"Done selecting"', "button"), /aria-pressed=/);
  });
});
