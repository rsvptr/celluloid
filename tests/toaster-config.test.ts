import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("app Toaster config", () => {
  it("lifts desktop toasts over the bulk bar and keeps Sonner's 24px otherwise (EM-07)", async () => {
    const [layout, library] = await Promise.all([
      source("../src/app/(app)/layout.tsx"),
      source("../src/components/library.tsx"),
    ]);
    assert.match(layout, /offset=\{\{ bottom: "var\(--toast-bottom, 24px\)" \}\}/);
    assert.match(layout, /mobileOffset=\{\{\s*bottom: "var\(--toast-bottom, /);
    // The bar publishes its own measured height plus a gap at every width.
    assert.match(library, /"--toast-bottom",\s*`\$\{Math\.ceil\(bar\.getBoundingClientRect\(\)\.height\) \+ 8\}px`/);
  });
});
