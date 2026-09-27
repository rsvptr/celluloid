import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

// VE-12, partly reverted: the server-side active-import check left a stale
// empty upload box on Back (the router BFCache ignores route-handler writes)
// and ran a retire write on every /add render. The mount-time fetch stays; only
// the lazy review load is kept.
describe("/add active import check (VE-12)", () => {
  it("checks on mount in the client, not in the page render", async () => {
    const page = await source("../src/app/(app)/add/page.tsx");
    assert.doesNotMatch(page, /getActiveImportJobView|import-staging/);
    const upload = await source("../src/app/(app)/add/import-upload.tsx");
    assert.match(
      upload,
      /useEffect\(\(\) => \{\s*const controller = new AbortController\(\);\s*fetchActiveImport\(controller\.signal\)/,
    );
    assert.match(upload, /fetch\("\/api\/import\/jobs\/active"/);
  });

  it("loads the review lazily", async () => {
    const upload = await source("../src/app/(app)/add/import-upload.tsx");
    assert.doesNotMatch(upload, /^import[^;]*["']@\/components\/import-review["']/m);
    assert.match(upload, /dynamic\(\s*\(\) => import\("@\/components\/import-review"\)/);
  });
});
