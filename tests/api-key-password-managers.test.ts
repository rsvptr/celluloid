import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// Password managers treated the masked Anthropic API key as a login password.
describe("Anthropic API key field", () => {
  it("opts out of 1Password, LastPass and Bitwarden and stays masked", async () => {
    const section = await readFile(new URL("../src/app/(app)/settings/api-key-section.tsx", import.meta.url), "utf8");
    const at = section.indexOf('name="anthropic-api-key"');
    assert.notEqual(at, -1);
    const input = section.slice(section.lastIndexOf("<Input", at), section.indexOf("/>", at));
    assert.match(input, /type="password"/);
    assert.match(input, /autoComplete="off"/);
    assert.match(input, /\sdata-1p-ignore\s/);
    assert.match(input, /\sdata-lpignore="true"\s/);
    assert.match(input, /\sdata-bwignore\s/);
  });
});
