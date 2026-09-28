import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// PR-01: bulkSetStatus returns { count, failed } when only some titles saved.
// The bar says how many did and how many didn't instead of a plain success,
// and keeps the chosen status so Apply can retry.
describe("bulk status partial failure (PR-01)", () => {
  it("reports saved and failed counts, and keeps the success toast as it was", async () => {
    const bar = await readFile(
      new URL("../src/components/library-bulk-bar.tsx", import.meta.url),
      "utf8",
    );
    const run = bar.slice(bar.indexOf("function run("), bar.indexOf("function removeSelected()"));
    assert.match(run, /failed\?: number/);
    assert.match(
      run,
      /if \(res\.failed\) \{\s*toast\.error\(\s*`\$\{verb\} \$\{changed\} \$\{changed === 1 \? "title" : "titles"\}\. \$\{res\.failed\} couldn't be updated\.`,\s*\);\s*return;\s*\}/,
    );
    assert.match(
      run,
      /toast\.success\(`\$\{verb\} \$\{changed\} \$\{changed === 1 \? "title" : "titles"\}`\);/,
    );

    const apply = bar.slice(
      bar.indexOf("function applyBulkStatus()"),
      bar.indexOf('}, "Updated");'),
    );
    assert.match(apply, /if \(!result\.error && !result\.failed\) setBulkStatus\(""\);/);
  });
});
