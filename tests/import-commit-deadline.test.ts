import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

const job = {
  id: "job-1",
  userId: "user-1",
  filename: "library.xlsx",
  status: "READY_FOR_REVIEW",
  createdAt: new Date("2026-08-29T00:00:00.000Z"),
  committedAt: null,
  summary: null,
  items: [
    {
      id: "item-1",
      rowNumber: 1,
      normalized: {
        parsed: {
          source: "upload",
          mediaType: "movie",
          name: "Heat",
          releaseDateText: "1995",
          releaseDate: "1995-01-01",
          status: "WATCHED",
          languageHint: null,
        },
        proposed: {
          tmdbId: 949,
          mediaType: "movie",
          name: "Heat",
          year: "1995",
          posterPath: null,
        },
      },
      proposedTmdbId: 949,
      proposedMediaType: "MOVIE",
      matchScore: 0.98,
      action: "CREATE",
      excluded: false,
      titleId: null,
      errorCode: null,
      warning: null,
      attempts: 0,
    },
  ],
};

let stateReads = 0;
let itemReads = 0;
const fakePrisma = {
  importJob: {
    updateMany: async () => ({ count: 1 }),
    findFirst: async ({ select }: { select?: { status?: boolean } }) => {
      if (select?.status) stateReads += 1;
      return select?.status ? { status: "COMMITTING" } : job;
    },
  },
  importItem: {
    findFirst: async () => {
      itemReads += 1;
      return null;
    },
  },
};

Object.assign(globalThis, { __CELLULOID_IMPORT_COMMIT_PRISMA__: fakePrisma });

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const prisma = globalThis.__CELLULOID_IMPORT_COMMIT_PRISMA__;",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/actions" || normalized.endsWith("/src/lib/actions")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function addFromTmdb() { throw new Error('unexpected item write'); }" +
        "export async function rematchTitle() { throw new Error('unexpected item write'); }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function findByImdbId() { throw new Error('unexpected TMDB read'); }" +
        "export async function getMovie() { throw new Error('unexpected TMDB read'); }" +
        "export async function getTv() { throw new Error('unexpected TMDB read'); }" +
        "export async function searchByType() { throw new Error('unexpected TMDB read'); }",
      ),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { commitImportJobChunk } = await import("../src/lib/import-staging");

describe("import commit request deadline", { concurrency: false }, () => {
  it("leaves the next item untouched when the request budget has expired", async () => {
    stateReads = 0;
    itemReads = 0;

    const result = await commitImportJobChunk("user-1", "job-1", Date.now() - 1);

    assert.equal(result?.status, "COMMITTING");
    assert.equal(result?.items[0]?.titleId, null);
    assert.equal(result?.items[0]?.attempts, 0);
    assert.equal(stateReads, 0, "deadline check runs before the per-item state read");
    assert.equal(itemReads, 0, "no item write starts after the deadline");
  });
});
