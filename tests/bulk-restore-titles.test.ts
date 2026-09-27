import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

// VE-01: a bulk remove's Undo restores the whole selection in one server
// action, instead of one queued action (and one library re-render) per title.

type UpdateManyArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

const state = {
  signedIn: true,
  updateManyCalls: [] as UpdateManyArgs[],
  revalidated: [] as string[],
  restoredCount: 0,
};
Object.assign(globalThis, {
  __CELLULOID_BULK_RESTORE__: state,
  __CELLULOID_BULK_RESTORE_PRISMA__: {
    title: {
      updateMany: async (args: UpdateManyArgs) => {
        state.updateManyCalls.push(args);
        return { count: state.restoredCount };
      },
    },
  },
});

const mockModules = new Map<string, string>([
  ["@/lib/prisma", "export const prisma = globalThis.__CELLULOID_BULK_RESTORE_PRISMA__;"],
  [
    "@/lib/session",
    'export async function getSession() { return globalThis.__CELLULOID_BULK_RESTORE__.signedIn ? { user: { id: "user-1" } } : null; }',
  ],
  [
    "next/cache",
    "export function revalidatePath(path) { globalThis.__CELLULOID_BULK_RESTORE__.revalidated.push(path); }",
  ],
  [
    "@/lib/tmdb",
    "export async function getMovie() { throw new Error('unused'); }\n" +
      "export async function getSeasons() { throw new Error('unused'); }\n" +
      "export const MAX_APPENDED_SEASONS = 20;\n" +
      "export async function getTv() { throw new Error('unused'); }",
  ],
]);
const loader = `
const modules = new Map(${JSON.stringify([...mockModules])});
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const source =
    modules.get(specifier) ??
    (normalized.endsWith("/src/lib/prisma")
      ? modules.get("@/lib/prisma")
      : normalized.endsWith("/src/lib/session")
        ? modules.get("@/lib/session")
        : normalized.endsWith("/src/lib/tmdb")
          ? modules.get("@/lib/tmdb")
          : undefined);
  if (source !== undefined) {
    return {
      url: "data:text/javascript," + encodeURIComponent(source),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { bulkRestoreTitles } = await import("../src/lib/actions");

describe("bulkRestoreTitles (VE-01)", { concurrency: false }, () => {
  beforeEach(() => {
    state.signedIn = true;
    state.updateManyCalls = [];
    state.revalidated = [];
    state.restoredCount = 0;
  });

  it("restores the owner's trashed titles in one update and revalidates once", async () => {
    state.restoredCount = 2;

    const result = await bulkRestoreTitles(["title-a", "title-b", "title-a"]);

    assert.deepEqual(result, { count: 2 });
    assert.deepEqual(state.updateManyCalls, [
      {
        where: { id: { in: ["title-a", "title-b"] }, userId: "user-1", deletedAt: { not: null } },
        data: { deletedAt: null },
      },
    ]);
    // One revalidateAll for the whole batch, with no per-title paths.
    assert.deepEqual(state.revalidated, ["/", "/stats", "/export"]);
  });

  it("reports the rows actually restored, not the ids sent", async () => {
    // A title restored through Trash in another tab no longer matches.
    state.restoredCount = 1;
    assert.deepEqual(await bulkRestoreTitles(["title-a", "title-b"]), { count: 1 });
  });

  it("does nothing when signed out, invalid or over the bulk limit", async () => {
    state.signedIn = false;
    assert.deepEqual(await bulkRestoreTitles(["title-a"]), {
      error: "You're signed out. Sign in and try again.",
    });
    state.signedIn = true;

    const invalid = { error: "Invalid request. Refresh and try again." };
    assert.deepEqual(await bulkRestoreTitles([""]), invalid);
    assert.deepEqual(await bulkRestoreTitles(["x".repeat(65)]), invalid);
    assert.deepEqual(await bulkRestoreTitles("title-a" as unknown as string[]), invalid);

    assert.deepEqual(
      await bulkRestoreTitles(Array.from({ length: 1001 }, (_, index) => `title-${index}`)),
      { error: "Too many titles selected (max 1000)." },
    );

    assert.equal(state.updateManyCalls.length, 0);
    assert.deepEqual(state.revalidated, []);
  });

  it("counts the limit after dedupe, like the other bulk actions", async () => {
    const ids = [
      ...Array.from({ length: 1000 }, (_, index) => `title-${index}`),
      "title-0",
    ];
    state.restoredCount = 1000;
    assert.deepEqual(await bulkRestoreTitles(ids), { count: 1000 });
    assert.equal((state.updateManyCalls[0].where.id as { in: string[] }).in.length, 1000);
  });

  it("is what the library's bulk Undo calls, once for the whole selection", async () => {
    const library = await readFile(
      new URL("../src/components/library-bulk-bar.tsx", import.meta.url),
      "utf8",
    );
    const removeSelected = library.slice(
      library.indexOf("function removeSelected()"),
      library.indexOf("function applyBulkStatus()"),
    );
    assert.match(removeSelected, /undo: \(\) => bulkRestoreTitles\(removedIds\)/);
    assert.doesNotMatch(removeSelected, /restoreTitle\(/);
    // A failed undo still re-syncs through P1's toast helper.
    assert.match(removeSelected, /onError: \(\) => router\.refresh\(\)/);
  });
});
