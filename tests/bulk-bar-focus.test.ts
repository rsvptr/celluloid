import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

// Chrome moves focus to <body> the instant a focused control becomes natively
// `disabled`. Apply goes disabled while it runs and again after success
// (setBulkStatus("")), so it must soft-disable like the rest of the bar (JK-08).
describe("bulk bar status controls keep focus (JK-08)", () => {
  it("soft-disables the status select and Apply, with guarded handlers", async () => {
    const library = await source("../src/components/library.tsx");

    const selectAt = library.indexOf("value={bulkStatus}");
    const select = library.slice(
      library.lastIndexOf("<Select", selectAt),
      library.indexOf("</Select>", selectAt),
    );
    assert.match(select, /aria-disabled=\{disabled\}/);
    assert.doesNotMatch(select, /\sdisabled=\{/);
    assert.match(select, /onChange=\{\(e\) => \{[^}]*if \(disabled\) return;\s*setBulkStatus/);
    assert.match(select, /softDisabledClass/);

    const applyAt = library.indexOf("onClick={applyBulkStatus}");
    const apply = library.slice(
      library.lastIndexOf("<Button", applyAt),
      library.indexOf("</Button>", applyAt),
    );
    assert.match(apply, /aria-disabled=\{disabled \|\| !bulkStatus\}/);
    assert.doesNotMatch(apply, /\sdisabled=\{/);
    assert.match(apply, /softDisabledClass/);

    const handler = library.slice(
      library.indexOf("function applyBulkStatus()"),
      library.indexOf("run(", library.indexOf("function applyBulkStatus()")),
    );
    assert.match(handler, /if \(disabled \|\| !bulkStatus\) return;/);
  });
});
