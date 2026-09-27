import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

// PR-09: the import-job reads select the fields review, reconcile and commit
// use, and leave out each row's raw upload JSON. tests/import-withdrawn-counts
// runs the same queries against Postgres through a real commit.

type Args = { select?: Record<string, unknown>; include?: unknown };
const calls: { model: string; args: Args }[] = [];

const row = {
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
    proposed: { tmdbId: 949, mediaType: "movie", name: "Heat", year: "1995", posterPath: null },
  },
  proposedTmdbId: 949,
  proposedMediaType: "MOVIE",
  matchScore: 0.98,
  action: "CREATE",
  titleId: null,
  errorCode: null,
  warning: null,
  attempts: 0,
};
const job = () => ({
  id: "job-1",
  filename: "library.csv",
  status: "READY_FOR_REVIEW",
  summary: null,
  createdAt: new Date("2026-09-27T00:00:00.000Z"),
  committedAt: null,
  items: [{ ...row }],
});

const fakePrisma = {
  importJob: {
    findFirst: async (args: Args) => {
      calls.push({ model: "importJob", args });
      return args.select && !args.select.items ? { status: "COMMITTING", id: "job-1" } : job();
    },
    updateMany: async () => ({ count: 1 }),
  },
  importItem: {
    // A skipped row ends the commit and review paths right after this read.
    findFirst: async (args: Args) => {
      calls.push({ model: "importItem", args });
      return { ...row, action: "SKIP" };
    },
    update: async () => ({}),
  },
  title: { findMany: async () => [] },
  $transaction: async (writes: Promise<unknown>[]) => Promise.all(writes),
};
Object.assign(globalThis, { __CELLULOID_JOB_READS_PRISMA__: fakePrisma });

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const stub = (source) => ({
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  });
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_JOB_READS_PRISMA__;");
  }
  if (specifier === "@/lib/actions" || normalized.endsWith("/src/lib/actions")) {
    return stub(
      "export async function addFromTmdb() { throw new Error('unexpected title write'); }" +
      "export async function rematchTitle() { throw new Error('unexpected title write'); }",
    );
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "export async function findByImdbId() { throw new Error('unused'); }" +
      "export async function findTvByTvdbId() { throw new Error('unused'); }" +
      "export async function getMovie() { throw new Error('unused'); }" +
      "export async function getTv() { throw new Error('unused'); }" +
      "export async function searchByType() { throw new Error('unused'); }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { commitImportJobChunk, getActiveImportJobView, getImportJobView, updateImportItemReview } =
  await import("../src/lib/import-staging");

const ITEM_FIELDS = [
  "action",
  "attempts",
  "errorCode",
  "id",
  "matchScore",
  "normalized",
  "proposedMediaType",
  "proposedTmdbId",
  "rowNumber",
  "titleId",
  "warning",
];

function assertJobRead(args: Args) {
  assert.equal(args.include, undefined);
  assert.deepEqual(Object.keys(args.select ?? {}).sort(), [
    "committedAt",
    "createdAt",
    "filename",
    "id",
    "items",
    "status",
    "summary",
  ]);
  const items = args.select?.items as { select: Record<string, true>; orderBy: unknown };
  assert.deepEqual(Object.keys(items.select).sort(), ITEM_FIELDS);
  assert.deepEqual(items.orderBy, { rowNumber: "asc" });
}

beforeEach(() => {
  calls.length = 0;
});

describe("import-job reads leave out raw rows (PR-09)", { concurrency: false }, () => {
  it("selects the job view's fields for a job and the active job", async () => {
    const view = await getImportJobView("user-1", "job-1");
    assert.equal(view?.items[0]?.parsed.name, "Heat");
    await getActiveImportJobView("user-1");

    const jobReads = calls.filter((call) => call.model === "importJob");
    assert.equal(jobReads.length, 2);
    for (const call of jobReads) assertJobRead(call.args);
  });

  it("selects only what review and commit use from a single row", async () => {
    await updateImportItemReview({ userId: "user-1", jobId: "job-1", itemId: "item-1" });
    await commitImportJobChunk("user-1", "job-1");

    const [review, commit] = calls.filter((call) => call.model === "importItem");
    assert.deepEqual(Object.keys(review.args.select ?? {}).sort(), [
      "attempts",
      "id",
      "matchScore",
      "normalized",
      "rowNumber",
      "titleId",
    ]);
    assert.deepEqual(Object.keys(commit.args.select ?? {}).sort(), [
      "action",
      "attempts",
      "id",
      "normalized",
      "titleId",
    ]);
    for (const call of calls.filter((c) => c.model === "importJob" && c.args.select?.items)) {
      assertJobRead(call.args);
    }
  });
});
