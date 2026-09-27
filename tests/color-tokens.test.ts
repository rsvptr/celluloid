import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";
import { STATUS_META } from "../src/lib/format";
import {
  TAG_COLORS,
  TAG_COLOR_DEFAULT_CHIP,
  TAG_COLOR_META,
  isTagColor,
  tagChipClass,
  tagColorKey,
} from "../src/lib/tag-colors";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

/** The palette family each status token points at, from globals.css. */
async function statusFamilies() {
  const css = await source("../src/app/globals.css");
  const families = new Map<string, string>();
  for (const m of css.matchAll(/--color-(status-[a-z-]+-text): var\(--color-([a-z]+)-300\)/g)) {
    families.set(m[1], m[2]);
  }
  return { css, families };
}

/** oklch hue of a Tailwind palette step, from Tailwind's own theme. */
async function hue(family: string, step = 300) {
  const theme = await source("../node_modules/tailwindcss/theme.css");
  const m = theme.match(new RegExp(`--color-${family}-${step}: oklch\\([\\d.]+% [\\d.]+ ([\\d.]+)\\)`));
  assert.ok(m, `no ${family}-${step} in the Tailwind theme`);
  return Number(m[1]);
}

const hueDistance = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe("status color tokens (JK-16)", () => {
  it("every status uses its own tokens, and each token is defined", async () => {
    const { css, families } = await statusFamilies();
    for (const [status, meta] of Object.entries(STATUS_META)) {
      const role = `status-${status.toLowerCase().replace("_", "-")}`;
      assert.equal(meta.dot, `bg-${role}-solid`, status);
      assert.equal(meta.badge, `bg-${role}-subtle text-${role}-text ring-${role}-border`, status);
      for (const step of ["text", "solid", "subtle", "border"]) {
        assert.match(css, new RegExp(`--color-${role}-${step}:`), `${role}-${step}`);
      }
    }
    assert.equal(families.size, Object.keys(STATUS_META).length);
    assert.equal(new Set(families.values()).size, families.size, "one hue per status");
  });

  it("text on a filled accent uses the on-accent token", async () => {
    const files = [
      "../src/components/ui.tsx",
      "../src/components/library-toolbar.tsx",
      "../src/components/library-results.tsx",
      "../src/components/title-card.tsx",
      "../src/app/(app)/add/add-search.tsx",
      "../src/app/(app)/title/[id]/season-tracker.tsx",
      "../src/app/(app)/settings/my-services-section.tsx",
      "../src/app/(app)/recommend/rec-card.tsx",
      "../src/app/(app)/recommend/title-picker.tsx",
    ];
    for (const file of files) {
      const text = await source(file);
      assert.doesNotMatch(text, /#04121c/, file);
      assert.match(text, /text-on-accent/, file);
    }
    // Settings is split across files; none of them may hard-code the color.
    const settingsDir = new URL("../src/app/(app)/settings/", import.meta.url);
    for (const name of await readdir(settingsDir)) {
      assert.doesNotMatch(await readFile(new URL(name, settingsDir), "utf8"), /#04121c/, name);
    }
    assert.match(await source("../src/app/globals.css"), /--color-on-accent: #04121c;/);
  });
});

describe("tag palette (JK-17)", () => {
  it("keeps every tag hue at least 22° from every status hue", async () => {
    const { families } = await statusFamilies();
    for (const tag of TAG_COLORS) {
      assert.match(TAG_COLOR_META[tag].chip, new RegExp(`text-${tag}-300`));
      for (const status of families.values()) {
        for (const step of [300, 500]) {
          const d = hueDistance(await hue(tag, step), await hue(status, step));
          assert.ok(d >= 22, `${tag} is ${d.toFixed(1)}° from ${status} at ${step}`);
        }
      }
    }
  });

  it("renders colors from the first palette as their nearest tag hue", () => {
    assert.equal(tagColorKey("rose"), "pink");
    assert.equal(tagColorKey("amber"), "orange");
    assert.equal(tagColorKey("emerald"), "lime");
    assert.equal(tagColorKey("sky"), "violet");
    assert.equal(tagColorKey("slate"), null);
    assert.equal(tagChipClass("rose"), TAG_COLOR_META.pink.chip);
    assert.equal(tagChipClass("slate"), TAG_COLOR_DEFAULT_CHIP);
  });

  it("only accepts the current palette for new writes", () => {
    assert.equal(isTagColor("pink"), true);
    assert.equal(isTagColor("rose"), false);
  });

  it("falls back to the neutral chip for anything else", () => {
    for (const value of [null, undefined, "", "#ff0000", "constructor", "toString"]) {
      assert.equal(tagColorKey(value), null);
      assert.equal(tagChipClass(value), TAG_COLOR_DEFAULT_CHIP);
    }
  });
});

describe("recommendation confidence (JK-17)", () => {
  it("borrows no status hue", async () => {
    const client = await source("../src/app/(app)/recommend/rec-card.tsx");
    const block = client.slice(client.indexOf("const CONFIDENCE = {"), client.indexOf("} as const;"));
    assert.doesNotMatch(block, /emerald|amber|slate|sky|rose|status-/);
  });
});
