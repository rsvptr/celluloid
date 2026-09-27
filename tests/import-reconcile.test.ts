import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import {
  INVALID_STAGED_ROW_ERROR,
  INVALID_STAGED_ROW_WARNING,
  MATCH_TIMED_OUT_ERROR,
  MATCH_TIMED_OUT_WARNING,
} from "../src/lib/import-staging-format";

type Row = {
  id: string;
  rowNumber: number;
  normalized: unknown;
  proposedTmdbId: number | null;
  proposedMediaType: "MOVIE" | "TV" | null;
  matchScore: number | null;
  action: string;
  titleId: string | null;
  errorCode: string | null;
  warning: string | null;
  attempts: number;
};

type UpdateManyArgs = {
  where: { jobId: string; id: { in: string[] } };
  data: { action: string; warning: string | null; errorCode: string | null };
};

// Prisma's updateMany returns a lazy promise that only runs when awaited or
// handed to $transaction. This stand-in runs only in $transaction, so a write
// sent outside the transaction would never land and the tests would see it.
const DEFERRED = Symbol("deferred write");
type DeferredWrite = { [DEFERRED]: UpdateManyArgs };

const NO_MATCH = "No confident TMDB match. Choose a match or exclude this row.";
const DUPLICATE = "Another row in this import uses the same TMDB title.";

let rows: Row[] = [];
let existingMovieIds = new Set<number>();
let failTransaction = false;
let transactions: Array<{ writes: UpdateManyArgs[]; timeout: number | undefined }> = [];

const fakePrisma = {
  importJob: {
    findFirst: async () => ({
      id: "job-1",
      userId: "user-1",
      filename: "library.xlsx",
      status: "READY_FOR_REVIEW",
      createdAt: new Date("2026-09-27T00:00:00.000Z"),
      committedAt: null,
      summary: null,
      items: rows.map((row) => ({ ...row })),
    }),
  },
  title: {
    findMany: async () =>
      [...existingMovieIds].map((tmdbId) => ({ mediaType: "MOVIE", tmdbId })),
  },
  importItem: {
    updateMany: (args: UpdateManyArgs): DeferredWrite => ({ [DEFERRED]: args }),
    update: async () => {
      throw new Error("reconcile wrote a single row");
    },
  },
  $transaction: async (writes: unknown, options?: { timeout?: number }) => {
    assert.ok(Array.isArray(writes), "reconcile's writes go in one batch transaction");
    const batch = (writes as DeferredWrite[]).map((write) => write[DEFERRED]);
    transactions.push({ writes: batch, timeout: options?.timeout });
    // All or nothing, the way Postgres applies the transaction.
    if (failTransaction) throw new Error("simulated write failure");
    return batch.map(({ where, data }) => {
      const matched = rows.filter(
        (row) => where.jobId === "job-1" && where.id.in.includes(row.id),
      );
      for (const row of matched) Object.assign(row, data);
      return { count: matched.length };
    });
  },
};

Object.assign(globalThis, { __CELLULOID_IMPORT_RECONCILE_PRISMA__: fakePrisma });

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
        "export const prisma = globalThis.__CELLULOID_IMPORT_RECONCILE_PRISMA__;",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/actions" || normalized.endsWith("/src/lib/actions")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function addFromTmdb() { throw new Error('unexpected title write'); }" +
        "export async function rematchTitle() { throw new Error('unexpected title write'); }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function findByImdbId() { throw new Error('unexpected TMDB read'); }" +
        "export async function findTvByTvdbId() { throw new Error('unexpected TMDB read'); }" +
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

const { reconcileImportActions } = await import("../src/lib/import-staging");

/** A staged movie row proposing TMDB id 1000 + rowNumber, as staging inserts it. */
function row(rowNumber: number, overrides: Partial<Row> = {}): Row {
  const tmdbId = 1000 + rowNumber;
  return {
    id: `item-${rowNumber}`,
    rowNumber,
    normalized: {
      parsed: {
        source: "upload",
        mediaType: "movie",
        name: `Film ${rowNumber}`,
        releaseDateText: null,
        releaseDate: null,
        status: "WATCHED",
        languageHint: null,
      },
      proposed: {
        tmdbId,
        mediaType: "movie",
        name: `Film ${rowNumber}`,
        year: "",
        posterPath: null,
      },
    },
    proposedTmdbId: tmdbId,
    proposedMediaType: "MOVIE",
    matchScore: 1,
    action: "CREATE",
    titleId: null,
    errorCode: null,
    warning: null,
    attempts: 0,
    ...overrides,
  };
}

/** The same row with no proposal, as an unmatched or timed-out row is staged. */
function unmatched(rowNumber: number, overrides: Partial<Row> = {}): Row {
  const base = row(rowNumber);
  return {
    ...base,
    normalized: { ...(base.normalized as object), proposed: null },
    proposedTmdbId: null,
    proposedMediaType: null,
    matchScore: null,
    ...overrides,
  };
}

/** The same row proposing another row's TMDB title. */
function proposing(rowNumber: number, tmdbId: number): Row {
  const base = row(rowNumber);
  const normalized = base.normalized as { parsed: object; proposed: object };
  return {
    ...base,
    normalized: { ...normalized, proposed: { ...normalized.proposed, tmdbId } },
    proposedTmdbId: tmdbId,
  };
}

function reset(next: Row[], existing: number[] = []) {
  rows = next;
  existingMovieIds = new Set(existing);
  failTransaction = false;
  transactions = [];
}

describe("import review reconcile", { concurrency: false }, () => {
  it("flips a re-imported library to UPDATE with one write in one transaction", async () => {
    const staged = Array.from({ length: 250 }, (_, index) => row(index + 1));
    const reimported = staged.slice(0, 240);
    reset(staged, reimported.map((item) => item.proposedTmdbId!));

    const view = await reconcileImportActions("user-1", "job-1");

    assert.equal(transactions.length, 1);
    assert.deepEqual(transactions[0].writes, [
      {
        where: { jobId: "job-1", id: { in: reimported.map((item) => item.id) } },
        data: { action: "UPDATE", warning: null, errorCode: null },
      },
    ]);
    assert.ok(
      (transactions[0].timeout ?? 0) > 5_000,
      "sets a timeout above Prisma's 5 s default",
    );
    assert.equal(view?.items.filter((item) => item.action === "UPDATE").length, 240);
    assert.equal(view?.items.filter((item) => item.action === "CREATE").length, 10);
  });

  it("groups rows by their new action, warning and error code", async () => {
    reset(
      [
        row(1),
        row(2),
        proposing(3, 1001),
        row(4),
        { ...row(5), normalized: { parsed: {}, proposed: null } },
        unmatched(6, {
          action: "CONFLICT",
          errorCode: MATCH_TIMED_OUT_ERROR,
          warning: NO_MATCH,
        }),
        row(7, { action: "SKIP", warning: "Left over from an earlier edit." }),
        row(8, { titleId: "title-8" }),
        row(9, { action: "FAILED", attempts: 3, errorCode: "IMPORT_WRITE_FAILED" }),
        row(10, {
          action: "FAILED",
          attempts: 1,
          errorCode: "IMPORT_WRITE_FAILED",
          warning: "Celluloid couldn't save this title. Retry after checking the match.",
        }),
        unmatched(11, { action: "CONFLICT", warning: NO_MATCH }),
        unmatched(12),
        proposing(13, 1001),
      ],
      [1001, 1004, 1008, 1009, 1010],
    );
    const untouched = ["item-2", "item-8", "item-9", "item-11"].map((id) => ({
      ...rows.find((item) => item.id === id)!,
    }));

    await reconcileImportActions("user-1", "job-1");

    assert.equal(transactions.length, 1);
    assert.deepEqual(
      transactions[0].writes.map(({ where, data }) => [data, where.id.in]),
      [
        [{ action: "UPDATE", warning: null, errorCode: null }, ["item-1", "item-4", "item-10"]],
        [{ action: "CONFLICT", warning: DUPLICATE, errorCode: null }, ["item-3", "item-13"]],
        [
          {
            action: "CONFLICT",
            warning: INVALID_STAGED_ROW_WARNING,
            errorCode: INVALID_STAGED_ROW_ERROR,
          },
          ["item-5"],
        ],
        [
          {
            action: "CONFLICT",
            warning: MATCH_TIMED_OUT_WARNING,
            errorCode: MATCH_TIMED_OUT_ERROR,
          },
          ["item-6"],
        ],
        [{ action: "SKIP", warning: null, errorCode: null }, ["item-7"]],
        [{ action: "CONFLICT", warning: NO_MATCH, errorCode: null }, ["item-12"]],
      ],
    );
    assert.ok(transactions[0].writes.every(({ where }) => where.jobId === "job-1"));
    for (const before of untouched) {
      assert.deepEqual(rows.find((item) => item.id === before.id), before, before.id);
    }
  });

  it("opens no transaction when every row already matches its plan", async () => {
    reset(
      [
        row(1),
        row(2, { action: "UPDATE" }),
        unmatched(3, { action: "CONFLICT", warning: NO_MATCH }),
      ],
      [1002],
    );

    const view = await reconcileImportActions("user-1", "job-1");

    assert.equal(transactions.length, 0);
    assert.deepEqual(
      view?.items.map((item) => item.action),
      ["CREATE", "UPDATE", "CONFLICT"],
    );
  });

  it("leaves every row as it was and rejects when the write fails", async () => {
    reset([row(1), row(2), unmatched(3)], [1001, 1002]);
    failTransaction = true;

    await assert.rejects(
      reconcileImportActions("user-1", "job-1"),
      /simulated write failure/,
    );

    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].writes.length, 2);
    assert.deepEqual(
      rows.map((item) => [item.action, item.warning]),
      [
        ["CREATE", null],
        ["CREATE", null],
        ["CREATE", null],
      ],
    );
  });
});
