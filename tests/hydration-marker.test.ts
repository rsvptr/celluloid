import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// The e2e suite waits for <html data-hydrated> before a page's first
// interaction (e2e/fixtures.ts), so the marker has to be set after hydration,
// on every page, and by nothing else.
describe("hydration marker", () => {
  it("is a client component that sets data-hydrated in an effect and renders nothing", async () => {
    const marker = await read("../src/components/hydration-marker.tsx");
    assert.match(marker, /^"use client";/);
    assert.match(
      marker,
      /useEffect\(\(\) => \{\s*document\.documentElement\.dataset\.hydrated = "true";\s*\}, \[\]\);\s*return null;/,
    );
  });

  it("is mounted by the root layout", async () => {
    const layout = await read("../src/app/layout.tsx");
    assert.match(layout, /import \{ HydrationMarker \} from "@\/components\/hydration-marker";/);
    assert.match(layout, /<body[^>]*>[\s\S]*<HydrationMarker \/>[\s\S]*<\/body>/);
  });

  it("is what the e2e navigation helper waits for", async () => {
    const fixtures = await read("../e2e/fixtures.ts");
    assert.match(fixtures, /toHaveAttribute\("data-hydrated", "true"\)/);
  });
});
