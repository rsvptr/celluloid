import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// After a failed load of a link's titles, closing and reopening Manage loaded
// them again, but the old error stayed on screen over the result.
describe("Shared links Manage retry", () => {
  it("clears the load error when a new load starts and when a load succeeds", async () => {
    const settings = await readFile(
      new URL("../src/app/(app)/settings/shared-links-section.tsx", import.meta.url),
      "utf8",
    );
    const load = settings.slice(settings.indexOf("getShareListTitles(s.id)"), settings.indexOf(".catch("));
    assert.match(load, /return;\s*\}\s*setTitlesError\(null\);\s*setTitles\(res\.titles\);/);

    const toggle = settings.slice(settings.indexOf("aria-controls={panelId}"), settings.indexOf("Manage\n"));
    assert.match(toggle, /if \(!manageOpen\) setTitlesError\(null\);\s*setManageOpen\(\(v\) => !v\);/);
    // The load only starts on open, while nothing has loaded yet.
    assert.match(settings, /if \(!manageOpen \|\| titles !== null\) return;/);
  });
});
