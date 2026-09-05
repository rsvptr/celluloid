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
let failSeed = false;
let addCalls = 0;
const fakePrisma = {
  importJob: {
    updateMany: async ({ data }: { data: { status?: string } }) => {
      if (data.status) job.status = data.status;
      return { count: 1 };
    },
    findFirst: async ({ select }: { select?: { status?: boolean } }) => {
      if (select?.status) stateReads += 1;
      return select?.status ? { status: "COMMITTING" } : job;
    },
  },
  importItem: {
    findFirst: async () => {
      itemReads += 1;
      return job.items[0];
    },
    update: async ({ data }: { data: Record<string, unknown> }) => {
      const attempts = data.attempts as { increment?: number } | undefined;
      Object.assign(job.items[0], {
        ...data,
        ...(attempts ? { attempts: job.items[0].attempts + (attempts.increment ?? 0) } : {}),
      });
      return job.items[0];
    },
  },
  title: {
    findUnique: async () => null,
    updateMany: async () => {
      if (failSeed) {
        failSeed = false;
        throw new Error("simulated personal-field seed failure");
      }
      return { count: 1 };
    },
  },
};

Object.assign(globalThis, { __CELLULOID_IMPORT_COMMIT_PRISMA__: fakePrisma });
Object.assign(globalThis, {
  __CELLULOID_IMPORT_ADD__: () => {
    addCalls += 1;
    return { id: "created-title-1" };
  },
});

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
        "export async function addFromTmdb() { return globalThis.__CELLULOID_IMPORT_ADD__(); }" +
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
    job.status = "READY_FOR_REVIEW";
    Object.assign(job.items[0], {
      action: "CREATE",
      titleId: null,
      errorCode: null,
      warning: null,
      attempts: 0,
    });

    const result = await commitImportJobChunk("user-1", "job-1", Date.now() - 1);

    assert.equal(result?.status, "COMMITTING");
    assert.equal(result?.items[0]?.titleId, null);
    assert.equal(result?.items[0]?.attempts, 0);
    assert.equal(stateReads, 0, "deadline check runs before the per-item state read");
    assert.equal(itemReads, 0, "no item write starts after the deadline");
  });

  it("checkpoints a created title when its personal-field seed fails", async () => {
    stateReads = 0;
    itemReads = 0;
    failSeed = true;
    addCalls = 0;
    job.status = "READY_FOR_REVIEW";
    Object.assign(job.items[0], {
      action: "CREATE",
      titleId: null,
      errorCode: null,
      warning: null,
      attempts: 0,
    });

    const result = await commitImportJobChunk("user-1", "job-1");

    assert.equal(result?.status, "COMPLETED");
    assert.equal(result?.items[0]?.titleId, "created-title-1");
    assert.equal(result?.items[0]?.action, "CREATE");
    assert.equal(result?.items[0]?.errorCode, null);
    assert.match(result?.items[0]?.warning ?? "", /saved without its status and rating/i);
    assert.equal(result?.items[0]?.attempts, 1);
    assert.equal(addCalls, 1);
  });

  it("retries only the personal-field seed for a row that already has a title", async () => {
    stateReads = 0;
    itemReads = 0;
    failSeed = false;
    addCalls = 0;
    job.status = "PARTIAL";
    Object.assign(job.items[0], {
      action: "FAILED",
      titleId: "created-title-1",
      errorCode: "IMPORT_WRITE_FAILED",
      warning: "Saved without its status and rating.",
      attempts: 1,
    });

    const result = await commitImportJobChunk("user-1", "job-1");

    assert.equal(result?.status, "COMPLETED");
    assert.equal(result?.items[0]?.titleId, "created-title-1");
    assert.equal(result?.items[0]?.action, "CREATE");
    assert.equal(result?.items[0]?.errorCode, null);
    assert.equal(result?.items[0]?.warning, null);
    assert.equal(result?.items[0]?.attempts, 2);
    assert.equal(addCalls, 0, "the retry does not create or rematch the title");
  });
});
