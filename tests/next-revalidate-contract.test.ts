import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// Canary for the Next behavior VE-02 and VE-03 lean on: any revalidatePath in
// a server action, whatever the path, flags the store so the action handler
// renders the *current* page into the action's response. revalidate.js does
// this under "TODO: only revalidate if the path matches". The router.refresh()
// calls after revalidating actions were dropped on the strength of it, and
// title-page edits no longer revalidate the title's own path. If a Next upgrade
// resolves that TODO, this fails: switch the action-only entry points to
// refresh() from next/cache (not the route-handler paths, where it throws).

// Next's server runtime expects this global; next start sets it up.
Object.assign(globalThis, { AsyncLocalStorage: globalThis.AsyncLocalStorage ?? AsyncLocalStorage });
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { revalidatePath } = require("next/cache");
const { ActionDidRevalidateStaticAndDynamic } = require(
  "next/dist/shared/lib/action-revalidation-kind.js",
);

/** A minimal work store for an action posted from a title page. */
function titlePageStore(): Record<string, unknown> {
  return {
    incrementalCache: {},
    route: "/title/[id]",
    page: "/(app)/title/[id]/page",
    cacheLifeProfiles: {},
  };
}

describe("Next revalidatePath contract (VE-02)", () => {
  it("marks the current page for re-render when only other paths are revalidated", () => {
    const store = titlePageStore();
    // What revalidateAll() in src/lib/actions.ts does.
    workAsyncStorage.run(store, () => {
      revalidatePath("/");
      revalidatePath("/stats");
      revalidatePath("/export");
    });
    assert.equal(store.pathWasRevalidated, ActionDidRevalidateStaticAndDynamic);
  });

  it("leaves the flag unset when nothing is revalidated", () => {
    const store = titlePageStore();
    workAsyncStorage.run(store, () => {});
    assert.equal(store.pathWasRevalidated, undefined);
  });
});
