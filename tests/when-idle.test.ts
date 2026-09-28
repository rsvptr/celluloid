import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { whenIdle } from "../src/lib/when-idle";

const g = globalThis as { window?: unknown };
afterEach(() => {
  delete g.window;
});

// P7U-4: the command palette had its own copy of this scheduling; it now uses
// whenIdle, so both keep the same timing: idle within 2 s, or 300 ms without
// requestIdleCallback.
describe("whenIdle (P7U-4)", () => {
  it("waits for idle with a 2 s timeout, and cancels it", () => {
    const calls: unknown[][] = [];
    g.window = {
      requestIdleCallback: (...args: unknown[]) => (calls.push(["request", ...args]), 7),
      cancelIdleCallback: (id: number) => calls.push(["cancel", id]),
    };
    const run = () => {};
    whenIdle(run)();
    assert.deepEqual(calls, [
      ["request", run, { timeout: 2000 }],
      ["cancel", 7],
    ]);
  });

  it("falls back to a 300 ms timer without requestIdleCallback", () => {
    const calls: unknown[][] = [];
    g.window = {
      setTimeout: (...args: unknown[]) => (calls.push(["set", ...args]), 9),
      clearTimeout: (id: number) => calls.push(["clear", id]),
    };
    const run = () => {};
    whenIdle(run)();
    assert.deepEqual(calls, [
      ["set", run, 300],
      ["clear", 9],
    ]);
  });

  it("is what the command palette schedules its idle mount with", async () => {
    const palette = await readFile(
      new URL("../src/components/command-palette-lazy.tsx", import.meta.url),
      "utf8",
    );
    assert.match(palette, /const cancelIdle = whenIdle\(arm\);/);
    assert.match(palette, /return \(\) => \{[^}]*cancelIdle\(\);\s*\};/);
    assert.doesNotMatch(palette, /requestIdleCallback|setTimeout/);
  });
});
