import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// WCAG 1.4.11: a control's boundary needs 3:1. The unchecked boxes and the off
// switch drew theirs with the decorative `line` hairline, 1.27:1 (JK-05).
describe("unchecked checkbox and switch boundaries (JK-05)", () => {
  it("line-strong clears 3:1 against the surfaces these controls sit on", async () => {
    const css = await source("../src/app/globals.css");
    const token = (name: string) => {
      const value = css.match(new RegExp(`--color-${name}: (#[0-9a-f]{6});`))?.[1];
      assert.ok(value, `--color-${name} not found`);
      return value;
    };
    for (const surface of ["surface", "surface-2"]) {
      assert.ok(contrast(token("line-strong"), token(surface)) >= 3, surface);
    }
  });

  it("the three unchecked states use ring-line-strong", async () => {
    const [tracker, library, settings] = await Promise.all([
      source("../src/app/(app)/title/[id]/season-tracker.tsx"),
      source("../src/components/library.tsx"),
      source("../src/app/(app)/settings/settings-client.tsx"),
    ]);
    assert.match(tracker, /"brand-gradient ring-transparent"\s*: "bg-surface-2 ring-line-strong"/);
    assert.match(library, /"bg-brand text-on-accent ring-brand" : "ring-line-strong"/);
    assert.match(settings, /enabled \? "bg-brand ring-brand" : "bg-surface ring-line-strong"/);
  });
});
