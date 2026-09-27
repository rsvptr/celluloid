import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

// VE-03: revalidatePath(`/title/${id}`) expires the TMDB Data Cache entries
// the title page fetched under that path tag, so every edit (notes autosaves
// included) refetched TMDB. Edits now leave the title path alone; the page
// still comes back rendered because any revalidatePath re-renders the current
// page into the action's response. A metadata refresh still expires it.

const state = { revalidated: [] as string[] };
const lockedRow = {
  id: "title-1",
  tmdbId: 603,
  mediaType: "MOVIE",
  status: "WATCHLIST",
  watchedAt: null,
  totalEpisodes: null,
};
const tx = {
  $queryRaw: async () => [lockedRow],
  season: { deleteMany: async () => ({ count: 0 }) },
  title: { update: async () => ({ id: "title-1" }) },
};
Object.assign(globalThis, {
  __CELLULOID_TITLE_CACHE__: state,
  __CELLULOID_TITLE_CACHE_PRISMA__: {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
    title: {
      updateMany: async () => ({ count: 1 }),
      // rematchTitle reads the title, then looks for another row on that entry.
      findFirst: async ({ where }: { where: { NOT?: unknown } }) =>
        where.NOT ? null : { id: "title-1" },
    },
  },
});

const mockModules = new Map<string, string>([
  ["@/lib/prisma", "export const prisma = globalThis.__CELLULOID_TITLE_CACHE_PRISMA__;"],
  ["@/lib/session", 'export async function getSession() { return { user: { id: "user-1" } }; }'],
  [
    "next/cache",
    "export function revalidatePath(path) { globalThis.__CELLULOID_TITLE_CACHE__.revalidated.push(path); }",
  ],
  [
    "@/lib/tmdb",
    "export async function getMovie() { return { title: 'The Matrix', original_title: 'The Matrix', overview: '', release_date: '1999-03-31', poster_path: null, backdrop_path: null, original_language: 'en', vote_average: 8, runtime: 136, genres: [] }; }\n" +
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

const { rematchTitle, removeTitle, restoreTitle, updateTitle } = await import(
  "../src/lib/actions"
);

const LIBRARY_PATHS = ["/", "/stats", "/export"];

describe("title page TMDB cache across edits (VE-03)", { concurrency: false }, () => {
  beforeEach(() => {
    state.revalidated = [];
  });

  it("keeps the title path out of a notes save", async () => {
    assert.deepEqual(await updateTitle("title-1", { notes: "Rewatch with subtitles" }), {});
    assert.deepEqual(state.revalidated, LIBRARY_PATHS);
  });

  it("keeps the title path out of other per-title writes", async () => {
    await removeTitle("title-1");
    await restoreTitle("title-1");
    assert.deepEqual(state.revalidated, [...LIBRARY_PATHS, ...LIBRARY_PATHS]);
  });

  it("still expires it on a metadata refresh, which should re-pull TMDB", async () => {
    assert.deepEqual(await rematchTitle("title-1", 603, "movie"), { ok: true });
    assert.deepEqual(state.revalidated, [...LIBRARY_PATHS, "/title/title-1"]);
  });

  it("uses only revalidatePath, which route handlers and the test stubs support", async () => {
    // refresh() throws E870 in route handlers, and the import commit route
    // runs addFromTmdb and rematchTitle; the next/cache stubs in these tests
    // export revalidatePath alone.
    const actions = await readFile(new URL("../src/lib/actions.ts", import.meta.url), "utf8");
    assert.deepEqual(actions.match(/^import .* from "next\/cache";$/gm), [
      'import { revalidatePath } from "next/cache";',
    ]);
  });
});
