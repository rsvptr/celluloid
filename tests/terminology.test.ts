import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("terminology and button labels (JK-32)", () => {
  it("says TV shows and All, like the library", async () => {
    const rec = await source("../src/app/(app)/recommend/recommend-form.tsx");
    assert.match(rec, /\["all", "All"\],\s*\["movie", "Movies"\],\s*\["tv", "TV shows"\],/);
    // Every .tsx file of the recommend route, so the ban covers all of it.
    const dir = new URL("../src/app/(app)/recommend/", import.meta.url);
    const names = (await readdir(dir)).filter((name) => name.endsWith(".tsx"));
    assert.ok(names.length >= 8, `only ${names.length} recommend files found`);
    for (const name of names) {
      assert.doesNotMatch(await readFile(new URL(name, dir), "utf8"), /Movies & TV/, name);
    }
  });

  it("names the share field a list name and describes what it hides", async () => {
    const share = await source("../src/components/share-dialog.tsx");
    assert.match(share, /List name \(optional\)/);
    assert.match(share, /Your ratings, notes and favorites stay private unless this is checked\./);
  });

  it("turns 2FA off with the words its confirm uses", async () => {
    // Every file of the settings route, so the wording rule covers all of it.
    const dir = new URL("../src/app/(app)/settings/", import.meta.url);
    const files = await Promise.all((await readdir(dir)).map((name) => readFile(new URL(name, dir), "utf8")));
    const settings = files.join("\n");
    assert.match(settings, /title: "Turn off two-factor authentication\?",[\s\S]{0,120}confirmLabel: "Turn off 2FA",/);
    assert.doesNotMatch(settings, /(?:en|dis)able 2FA/i);
  });

  it("gives Cancel import a distinct way to stay", async () => {
    const [confirm, review] = await Promise.all([
      source("../src/components/confirm-dialog.tsx"),
      source("../src/components/import-review.tsx"),
    ]);
    assert.match(confirm, /\{opts\.cancelLabel \?\? "Cancel"\}/);
    assert.match(review, /confirmLabel: "Cancel import",[\s\S]{0,120}cancelLabel: "Keep importing",/);
  });

  it("uses verb-complete labels and a named palette group", async () => {
    const [rec, palette] = await Promise.all([
      source("../src/app/(app)/recommend/rec-results.tsx"),
      source("../src/components/command-palette.tsx"),
    ]);
    assert.match(rec, /Show different picks\n/);
    assert.match(palette, /heading="Actions"/);
    assert.doesNotMatch(palette, /heading="Do"/);
  });
});
