import type { ParsedTitle } from "@/lib/import/parse-excel";

export type ExistingLibraryStatus =
  | "WATCHLIST"
  | "WATCHING"
  | "WATCHED"
  | "ON_HOLD"
  | "DROPPED";

export type ExistingImportState = {
  status: ExistingLibraryStatus;
  rating: number | null;
  watchedAt: Date | string | null;
};

export type ExistingImportPatch = {
  rating?: number;
  watchedAt?: string;
  status?: "WATCHING" | "WATCHED";
};

export function importStatusForParsed(
  parsed: ParsedTitle,
): "WATCHLIST" | "WATCHING" | "WATCHED" {
  if (parsed.status === "WATCHED") return "WATCHED";
  if (parsed.status === "PARTIALLY_WATCHED") return "WATCHING";
  return "WATCHLIST";
}

/**
 * Existing library state wins. A staged row may fill facts the owner has never
 * set and may advance the neutral WATCHLIST default, but it never replaces a
 * rating/date or an intentional tracking state. In particular, UNWATCHED is a
 * no-op: spreadsheet silence/negation cannot regress live progress.
 */
export function planExistingImportMerge(
  current: ExistingImportState,
  parsed: ParsedTitle,
): ExistingImportPatch {
  const patch: ExistingImportPatch = {};

  if (current.rating === null && parsed.rating != null) {
    patch.rating = parsed.rating;
  }
  if (
    current.watchedAt === null &&
    parsed.watchedAt &&
    /^\d{4}-\d{2}-\d{2}$/.test(parsed.watchedAt)
  ) {
    patch.watchedAt = parsed.watchedAt;
  }

  const importedStatus = importStatusForParsed(parsed);
  if (current.status === "WATCHLIST" && importedStatus !== "WATCHLIST") {
    patch.status = importedStatus;
  }

  return patch;
}

/** Plain row-level disclosure for review; every clause corresponds to the policy above. */
export function existingImportReviewFacts(parsed: ParsedTitle): string[] {
  const facts: string[] = [];
  if (parsed.rating != null) {
    facts.push("fills your missing rating and keeps any rating already set");
  }
  if (parsed.watchedAt) {
    facts.push("fills your missing watch date and keeps any date already set");
  }

  const importedStatus = importStatusForParsed(parsed);
  if (importedStatus === "WATCHLIST") {
    facts.push("keeps your current status; an Unwatched row never regresses it");
  } else {
    const label = importedStatus === "WATCHED" ? "Watched" : "Partially watched";
    facts.push(`uses ${label} only if your current status is Watchlist; otherwise keeps it`);
  }
  return facts;
}
