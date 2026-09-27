import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function tsxSources() {
  const entries = await readdir(SRC, { recursive: true });
  const files = entries
    .map((entry) => entry.replaceAll("\\", "/"))
    .filter((entry) => entry.endsWith(".tsx"));
  return Promise.all(
    files.map(async (file) => ({
      file: `src/${file}`,
      text: await readFile(new URL(file, SRC), "utf8"),
    })),
  );
}

// A Motion `initial` that starts invisible or collapsed. Server-rendered, it
// ships as inline `opacity:0` (or zero scale or height) and stays that way
// until hydration and the lazy feature chunk both finish, or forever if the
// chunk fails.
const HIDDEN_INITIAL =
  /initial=\{\{[^}]*?\b(?:opacity|scale[XY]?|pathLength|height):\s*0(?![.\d])/g;

// Interaction-driven elements that only mount after JS runs, so they are never
// server-rendered hidden. A new entry here needs the same justification, and
// the element needs data-motion-enter so a failed feature load still shows it.
const INTERACTION_ONLY = new Map([
  ["src/components/nav.tsx", 1], // mobile More menu
  ["src/components/library-bulk-bar.tsx", 1], // bulk action bar
  ["src/app/(app)/recommend/recommend-client.tsx", 1], // streamed-in cards
]);

describe("server-rendered content starts visible", () => {
  it("keeps hidden Motion initial states to interaction-only elements", async () => {
    const found = new Map<string, number>();
    for (const { file, text } of await tsxSources()) {
      const count = text.match(HIDDEN_INITIAL)?.length ?? 0;
      if (count > 0) found.set(file, count);
    }
    assert.deepEqual(
      Object.fromEntries(found),
      Object.fromEntries(INTERACTION_ONLY),
      "Use a motion-safe CSS entrance (globals.css) or initial={false} for content that can be server-rendered",
    );
  });

  it("imports only MotionProvider from the wrapper in server components", async () => {
    for (const { file, text } of await tsxSources()) {
      if (/^\s*["']use client["']/.test(text)) continue;
      const imports = text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*["'](?:@\/components|\.)\/motion["']/g,
      );
      for (const [, names] of imports) {
        const specifiers = names.split(",").map((name) => name.trim()).filter(Boolean);
        assert.deepEqual(
          specifiers.filter((name) => name !== "MotionProvider"),
          [],
          `${file} is a server component; its Motion entrance would render hidden`,
        );
      }
    }
  });

  it("handles a failed lazy feature load", async () => {
    const wrapper = await readFile(new URL("components/motion.tsx", SRC), "utf8");
    const start = wrapper.indexOf("const loadDomMax");
    assert.notEqual(start, -1);
    const loader = wrapper.slice(start, wrapper.indexOf("\n\n", start));
    assert.match(loader, /import\("motion\/react"\)/);
    assert.match(loader, /\.catch\([\s\S]*dataset\.motionFailed = ""/);
    assert.match(loader, /\.then\([\s\S]*delete document\.documentElement\.dataset\.motionFailed[\s\S]*\.catch\(/);
  });

  it("shows hidden Motion entrances at rest when the feature load fails", async () => {
    for (const { file, text } of await tsxSources()) {
      for (const match of text.matchAll(HIDDEN_INITIAL)) {
        const tag = text.slice(text.lastIndexOf("<", match.index), text.indexOf("<", match.index));
        assert.match(tag, /\sdata-motion-enter(?![\w-])/, `${file}: mark the element with ${match[0]} as data-motion-enter`);
      }
    }
    const css = await readFile(new URL("app/globals.css", SRC), "utf8");
    const rule = css.match(/\[data-motion-failed\] \[data-motion-enter\] \{([^}]*)\}/);
    assert.ok(rule, "globals.css needs the [data-motion-failed] [data-motion-enter] rule");
    assert.match(rule[1], /opacity: 1 !important;/);
    assert.match(rule[1], /transform: none !important;/);
  });
});
