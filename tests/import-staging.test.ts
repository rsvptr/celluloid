import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  deriveImportJobStatus,
  IMPORT_MAX_ATTEMPTS,
  isTerminalImportItem,
  planImportActions,
  safeStagedNormalized,
  scoreImportMatch,
} from "../src/lib/import-staging-format";
import type { ParsedTitle } from "../src/lib/import/parse-excel";
import {
  existingImportReviewFacts,
  planExistingImportMerge,
} from "../src/lib/import-merge";
import type { TmdbSearchItem } from "../src/lib/tmdb";

const parsed: ParsedTitle = {
  source: "upload",
  mediaType: "movie",
  name: "The Conversation",
  releaseDateText: "1974",
  releaseDate: "1974-01-01",
  status: "WATCHED",
  languageHint: null,
};

function candidate(overrides: Partial<TmdbSearchItem> = {}): TmdbSearchItem {
  return {
    id: 592,
    media_type: "movie",
    title: "The Conversation",
    release_date: "1974-04-07",
    vote_average: 7.5,
    poster_path: null,
    ...overrides,
  };
}

describe("staged import matching", () => {
  it("turns an oversized persisted row into a safe review placeholder", () => {
    const normalized = safeStagedNormalized(
      { parsed: { ...parsed, name: "x".repeat(501) }, proposed: null },
      7,
    );

    assert.equal(normalized.valid, false);
    assert.equal(normalized.data.parsed.name.length, 500);
    assert.equal(normalized.data.proposed, null);
  });

  it("preserves valid staged rows without changing their content", () => {
    const value = { parsed, proposed: null };
    const normalized = safeStagedNormalized(value, 1);

    assert.equal(normalized.valid, true);
    assert.deepEqual(normalized.data, value);
  });

  it("scores an exact title and year as high confidence", () => {
    assert.equal(scoreImportMatch(parsed, candidate()), 0.98);
  });

  it("scores a weak name and distant year below an exact match", () => {
    const weak = scoreImportMatch(
      parsed,
      candidate({ title: "Conversation Piece", release_date: "1985-01-01" }),
    );
    assert.ok(weak < scoreImportMatch(parsed, candidate()));
  });

  it("plans updates, creates, exclusions, unmatched rows, and duplicate conflicts", () => {
    const plan = planImportActions(
      [
        {
          id: "existing",
          rowNumber: 1,
          action: "CREATE",
          proposedTmdbId: 10,
          proposedMediaType: "MOVIE",
          excluded: false,
        },
        {
          id: "new",
          rowNumber: 2,
          action: "CREATE",
          proposedTmdbId: 20,
          proposedMediaType: "TV",
          excluded: false,
        },
        {
          id: "duplicate",
          rowNumber: 3,
          action: "CREATE",
          proposedTmdbId: 20,
          proposedMediaType: "TV",
          excluded: false,
        },
        {
          id: "unmatched",
          rowNumber: 4,
          action: "CONFLICT",
          proposedTmdbId: null,
          proposedMediaType: null,
          excluded: false,
        },
        {
          id: "excluded",
          rowNumber: 5,
          action: "SKIP",
          proposedTmdbId: 30,
          proposedMediaType: "MOVIE",
          excluded: true,
        },
      ],
      new Set(["MOVIE:10"]),
    );

    assert.equal(plan.get("existing")?.action, "UPDATE");
    assert.equal(plan.get("new")?.action, "CREATE");
    assert.equal(plan.get("duplicate")?.action, "CONFLICT");
    assert.equal(plan.get("unmatched")?.action, "CONFLICT");
    assert.equal(plan.get("excluded")?.action, "SKIP");
  });
});

describe("staged import resumability", () => {
  it("treats a produced title id as terminal regardless of its planned action", () => {
    assert.equal(
      isTerminalImportItem({ action: "CREATE", titleId: "title-1", attempts: 1 }),
      true,
    );
  });

  it("keeps retryable failures non-terminal and caps permanent retries", () => {
    assert.equal(
      isTerminalImportItem({ action: "FAILED", titleId: null, attempts: 1 }),
      false,
    );
    assert.equal(
      isTerminalImportItem({
        action: "FAILED",
        titleId: null,
        attempts: IMPORT_MAX_ATTEMPTS,
      }),
      true,
    );
  });

  it("derives committing, completed, and partial outcomes deterministically", () => {
    assert.equal(
      deriveImportJobStatus([{ action: "CREATE", titleId: null, attempts: 0 }]),
      "COMMITTING",
    );
    assert.equal(
      deriveImportJobStatus([
        { action: "CREATE", titleId: "title-1", attempts: 1 },
        { action: "SKIP", titleId: null, attempts: 0 },
      ]),
      "COMPLETED",
    );
    assert.equal(
      deriveImportJobStatus([
        { action: "CREATE", titleId: "title-1", attempts: 1 },
        { action: "CONFLICT", titleId: null, attempts: 0 },
      ]),
      "PARTIAL",
    );
  });
});

describe("existing-title import merge policy", () => {
  it("fills missing facts and advances only the neutral Watchlist status", () => {
    assert.deepEqual(
      planExistingImportMerge(
        { status: "WATCHLIST", rating: null, watchedAt: null },
        { ...parsed, rating: 9, watchedAt: "2025-04-03" },
      ),
      { rating: 9, watchedAt: "2025-04-03", status: "WATCHED" },
    );
    assert.deepEqual(
      planExistingImportMerge(
        { status: "WATCHLIST", rating: null, watchedAt: null },
        { ...parsed, status: "PARTIALLY_WATCHED" },
      ),
      { status: "WATCHING" },
    );
  });

  it("never overwrites existing facts or a deliberate non-Watchlist status", () => {
    for (const status of ["WATCHING", "WATCHED", "ON_HOLD", "DROPPED"] as const) {
      assert.deepEqual(
        planExistingImportMerge(
          { status, rating: 8, watchedAt: new Date("2024-01-01T00:00:00.000Z") },
          { ...parsed, rating: 10, watchedAt: "2025-04-03" },
        ),
        {},
      );
    }
  });

  it("treats an Unwatched row as a status no-op while still filling null facts", () => {
    const unwatched = {
      ...parsed,
      status: "UNWATCHED" as const,
      rating: 7.5,
      watchedAt: "2023-06-02",
    };
    assert.deepEqual(
      planExistingImportMerge(
        { status: "WATCHED", rating: null, watchedAt: null },
        unwatched,
      ),
      { rating: 7.5, watchedAt: "2023-06-02" },
    );
    assert.match(existingImportReviewFacts(unwatched).join(" "), /never regresses/);
  });

  it("describes every supplied mergeable fact on the affected row", () => {
    assert.deepEqual(
      existingImportReviewFacts({ ...parsed, rating: 9, watchedAt: "2025-04-03" }),
      [
        "fills your missing rating and keeps any rating already set",
        "fills your missing watch date and keeps any date already set",
        "uses Watched only if your current status is Watchlist; otherwise keeps it",
      ],
    );
  });
});

// --- Added for D-F9 follow-up test coverage (see tests/backup.test.ts for the
// matching restore-planner and merge-policy additions) -----------------------
describe("deriveImportJobStatus — exhausted-retry FAILED rows", () => {
  it("marks the job PARTIAL when a FAILED item has hit its max attempts (terminal, not retryable)", () => {
    assert.equal(
      deriveImportJobStatus([
        { action: "FAILED", titleId: null, attempts: IMPORT_MAX_ATTEMPTS },
      ]),
      "PARTIAL",
    );
  });
});
