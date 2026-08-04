import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveWatchRegion } from "../src/lib/watch-region";

describe("resolveWatchRegion", () => {
  it("uses the device cookie before the saved account preference", () => {
    assert.equal(resolveWatchRegion("GB", "US"), "GB");
  });

  it("falls back through the saved preference to the built-in default", () => {
    assert.equal(resolveWatchRegion("invalid", "IN"), "IN");
    assert.equal(resolveWatchRegion(null, "invalid"), "US");
  });
});
