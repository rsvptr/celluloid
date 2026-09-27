import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// Saving preferences with the default zone, UTC, failed with "That doesn't
// look like a valid time zone.": the action and the picker both used
// Intl.supportedValuesOf, which omits aliases such as UTC and Etc/UTC.
describe("preferences time zone", async () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const actions = await read("../src/lib/settings-actions.ts");
  const client = await read("../src/app/(app)/settings/preferences-section.tsx");

  it("validates with isIanaTimeZone, not the canonical-only list", () => {
    assert.match(actions, /timeZone: z[\s\S]*?\.refine\(isIanaTimeZone,/);
    assert.doesNotMatch(actions, /supportedValuesOf/);
  });

  it("offers UTC in the picker", () => {
    assert.match(
      client,
      /const TIME_ZONES: string\[\] =[\s\S]*?\? \["UTC", \.\.\.Intl\.supportedValuesOf\("timeZone"\)\.filter\(\(z\) => z !== "UTC"\)\]/,
    );
  });
});
