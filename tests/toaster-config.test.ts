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
    assert.match(
      layout,
      /offset=\{\{ bottom: "var\(--toast-bottom, var\(--toast-desktop-bottom, 24px\)\)" \}\}/,
    );
    assert.match(layout, /mobileOffset=\{\{\s*bottom: "var\(--toast-bottom, /);
    // The bar publishes its own measured height plus a gap at every width.
    assert.match(library, /"--toast-bottom",\s*`\$\{Math\.ceil\(bar\.getBoundingClientRect\(\)\.height\) \+ 8\}px`/);
  });

  it("clears the tab bar on Sonner's desktop layout until the bar hides at lg", async () => {
    const [layout, nav] = await Promise.all([
      source("../src/app/(app)/layout.tsx"),
      source("../src/components/nav.tsx"),
    ]);
    // The mobile tab bar is the fixed bottom bar hidden from lg up.
    assert.match(nav, /className="fixed inset-x-0 bottom-0 [^"]*\blg:hidden\b/);
    assert.match(
      layout,
      /className="\[--toast-desktop-bottom:calc\(4\.5rem\+env\(safe-area-inset-bottom\)\)\] lg:\[--toast-desktop-bottom:24px\]"/,
    );
  });

  it("marks error toasts with the danger token instead of a no-op richColors (JK-20)", async () => {
    const layout = await source("../src/app/(app)/layout.tsx");
    const toaster = layout.slice(layout.indexOf("<Toaster"), layout.indexOf("/>", layout.indexOf("toastOptions")));
    // richColors lost to the inline style and only leaked onto the close button.
    assert.doesNotMatch(toaster, /^\s*richColors\b/m);
    assert.match(toaster, /error: "border-danger\/60! \[&_\[data-icon\]\]:text-danger"/);
  });
});
