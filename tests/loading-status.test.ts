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
      // The first element returned is the busy root; its status text is
      // portaled out to the shell's live region at runtime.
      assert.match(text, /return \(\s*(?:\/\/[^\n]*\n\s*)*<div[^>]*aria-busy="true">\s*<LoadingStatus>Loading[^<]*…<\/LoadingStatus>/, file);
    }
  });

  it("LoadingStatus portals into the app shell's persistent live region", async () => {
    const status = await source("../src/components/route-status.tsx");
    const layout = await source("../src/app/(app)/layout.tsx");
    const skeleton = await source("../src/components/skeleton.tsx");
    // The region exists before any text lands in it, so additions are
    // announced; it sits outside <main>, so no aria-busy root contains it.
    assert.match(status, /<div id=\{ROUTE_STATUS_ID\} role="status" className="sr-only" \/>/);
    assert.match(status, /createPortal\(children, region\)/);
    assert.match(layout, /<\/main>\s*<RouteStatus \/>/);
    assert.match(skeleton, /export \{ LoadingStatus \} from "@\/components\/route-status";/);
  });

  it("the library has its own page title", async () => {
    const page = await source("../src/app/(app)/page.tsx");
    assert.match(page, /export const metadata: Metadata = \{ title: "Library" \};/);
  });
});
