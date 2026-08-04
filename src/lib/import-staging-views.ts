import type { ParsedTitle } from "@/lib/import/parse-excel";

// Client-safe half of the staged-import contract: the view types the review
// screen renders, the two pacing constants, and the one predicate it needs.
// Deliberately Zod-free — the review screen importing these through
// import-staging-format.ts dragged the full Zod chunk into /add's first load
// (AUD-NEXT-01). The server module re-exports everything here and annotates
// its schemas with these types, so the wire shape and the view shape cannot
// drift apart without a type error.

/**
 * Rows committed per request. This is also the resume granularity (a batch
 * that dies is re-run from its first row), so it trades restart cost against
 * round trips. Five meant a 250-row import spent 50 requests, each re-reading
 * the whole job, to write what one request's worth of TMDB work could cover.
 */
export const IMPORT_COMMIT_BATCH_SIZE = 20;
export const IMPORT_MAX_ATTEMPTS = 3;

export type ProposedImportMatch = {
  tmdbId: number;
  mediaType: "movie" | "tv";
  name: string;
  year: string;
  posterPath: string | null;
};

export type ImportItemAction = "CREATE" | "UPDATE" | "SKIP" | "CONFLICT" | "FAILED";
export type ImportJobStatus =
  | "PARSING"
  | "READY_FOR_REVIEW"
  | "COMMITTING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export interface StagedImportItemView {
  id: string;
  rowNumber: number;
  parsed: ParsedTitle;
  proposed: ProposedImportMatch | null;
  matchScore: number | null;
  action: ImportItemAction;
  titleId: string | null;
  errorCode: string | null;
  warning: string | null;
  attempts: number;
}

export interface StagedImportJobView {
  id: string;
  filename: string;
  status: ImportJobStatus;
  createdAt: string;
  committedAt: string | null;
  summary: Record<string, unknown> | null;
  items: StagedImportItemView[];
}

export function isTerminalImportItem(item: {
  action: ImportItemAction;
  titleId: string | null;
  attempts: number;
}): boolean {
  return (
    item.titleId !== null ||
    item.action === "SKIP" ||
    item.action === "CONFLICT" ||
    (item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS)
  );
}
