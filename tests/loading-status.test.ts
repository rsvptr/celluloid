import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

const LOADERS = [
  "../src/app/(app)/loading.tsx",
  "../src/app/(app)/add/loading.tsx",
  "../src/app/(app)/export/loading.tsx",
  "../src/app/(app)/recommend/loading.tsx",
  "../src/app/(app)/settings/loading.tsx",
  "../src/app/(app)/stats/loading.tsx",
  "../src/app/(app)/upcoming/loading.tsx",
  "../src/app/(app)/title/[id]/loading.tsx",
];

describe("loading skeletons speak (JK-23)", () => {
  it("every skeleton is aria-busy with polite status text", async () => {
    for (const file of LOADERS) {
      const text = await source(file);
      // The first element returned is the busy root, with the status inside it.
      assert.match(text, /return \(\s*(?:\/\/[^\n]*\n\s*)*<div[^>]*aria-busy="true">\s*<LoadingStatus>Loading[^<]*…<\/LoadingStatus>/, file);
    }
  });

  it("LoadingStatus is a visually hidden status region", async () => {
    const skeleton = await source("../src/components/skeleton.tsx");
    assert.match(skeleton, /<p role="status" className="sr-only">/);
  });

  it("the library has its own page title", async () => {
    const page = await source("../src/app/(app)/page.tsx");
    assert.match(page, /export const metadata: Metadata = \{ title: "Library" \};/);
  });
});
