import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(name: string) {
  return readFile(new URL(`../src/app/(app)/recommend/${name}`, import.meta.url), "utf8");
}

// Stopping before any pick said "No suggestions came back. Try a different
// focus or count.", as if the run had finished empty.
describe("recommend copy after Stop", () => {
  it("says the run was stopped, in the same empty-state paragraph", async () => {
    const results = await source("rec-results.tsx");
    const empty = results.slice(results.indexOf('{run.status === "done" && recs.length === 0 && ('));
    assert.match(
      empty,
      /^[^]*?<p className="py-8 text-center text-sm text-muted">\s*\{receivedAny\s*\? "You've hidden every suggestion[^"]*"\s*: run\.stopped\s*\? "Stopped before any suggestions came back\."\s*: "No suggestions came back\. Try a different focus or count\."\}/,
    );
  });

  it("marks the finish as stopped only when the current run was aborted", async () => {
    const client = await source("recommend-client.tsx");
    const final = client.slice(client.indexOf("} finally {"));
    assert.match(final, /if \(abortRef\.current === ac\) \{\s*dispatch\(\{\s*type: "finish",[^}]*stopped: ac\.signal\.aborted,\s*\}\);/);
  });
});
