import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// VE-10: Geist Mono appears in three rarely seen places, so it must not be
// preloaded on every page. Geist Sans is the body font and keeps its preload.
describe("root layout fonts (VE-10)", () => {
  it("preloads Geist Sans but not Geist Mono", async () => {
    const layout = await readFile(new URL("../src/app/layout.tsx", import.meta.url), "utf8");
    const call = (name: string) =>
      layout.match(new RegExp(`= ${name}\\(\\{([^}]*)\\}\\)`))?.[1] ?? assert.fail(`${name}() not found`);
    assert.match(call("Geist_Mono"), /\bpreload: false\b/);
    assert.doesNotMatch(call("Geist"), /\bpreload\b/);
  });
});
