import { z } from "zod";
import { norm, resultNames } from "@/lib/tmdb-match";
import type { ParsedTitle } from "@/lib/import/parse-excel";
import type { TmdbSearchItem } from "@/lib/tmdb";
import {
  isTerminalImportItem,
  type ImportItemAction,
  type ProposedImportMatch,
} from "@/lib/import-staging-views";

// The view types, pacing constants, and terminal predicate live in
// import-staging-views.ts so client code can import them without pulling Zod
// into the /add bundle. Everything is re-exported here so server callers keep
// one import; proposedMatchSchema below is annotated with the shared type so
// the two files cannot drift.
export {
  IMPORT_COMMIT_BATCH_SIZE,
  IMPORT_MAX_ATTEMPTS,
  isTerminalImportItem,
  type ImportItemAction,
  type ImportJobStatus,
  type ProposedImportMatch,
  type StagedImportItemView,
  type StagedImportJobView,
} from "@/lib/import-staging-views";

export const INVALID_STAGED_ROW_ERROR = "INVALID_STAGED_ROW";
export const INVALID_STAGED_ROW_WARNING =
  "This row contains invalid or oversized data. Choose a match or exclude it.";
/** Marks a row the staging deadline reached before it could be matched. */
export const MATCH_TIMED_OUT_ERROR = "IMPORT_MATCH_TIMED_OUT";
export const MATCH_TIMED_OUT_WARNING =
  "Matching ran out of time before this row. Choose a match or exclude it.";

export const parsedTitleSchema = z
  .object({
    source: z.string().min(1).max(200),
    mediaType: z.enum(["movie", "tv"]),
    name: z.string().min(1).max(500),
    releaseDateText: z.string().max(200).nullable(),
    releaseDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    status: z.enum(["WATCHED", "PARTIALLY_WATCHED", "UNWATCHED"]),
    languageHint: z.string().min(2).max(24).nullable(),
    // Spreadsheet extras. Optional so the legacy workbook's rows — which carry
    // none of them — still validate against the same schema.
    rating: z.number().min(0.5).max(10).nullable().optional(),
    ratingText: z.string().max(40).nullable().optional(),
    watchedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional(),
    imdbId: z
      .string()
      .regex(/^tt\d{5,12}$/)
      .nullable()
      .optional(),
    tmdbId: z.number().int().positive().nullable().optional(),
    tv: z
      .object({
        finalSeasonText: z.string().max(500).nullable(),
        totalSeasonsText: z.string().max(500).nullable(),
        totalSeasons: z.number().int().min(0).nullable(),
        releasedPendingText: z.string().max(500).nullable(),
        releasedSeasons: z.number().min(0).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const proposedMatchSchema: z.ZodType<ProposedImportMatch> = z
  .object({
    tmdbId: z.number().int().positive(),
    mediaType: z.enum(["movie", "tv"]),
    name: z.string().min(1).max(500),
    year: z.string().regex(/^\d{4}$/).or(z.literal("")),
    posterPath: z.string().max(1_000).nullable(),
  })
  .strict();

export const stagedNormalizedSchema = z
  .object({
    parsed: parsedTitleSchema,
    proposed: proposedMatchSchema.nullable(),
  })
  .strict();

export type StagedNormalized = z.infer<typeof stagedNormalizedSchema>;

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : fallback;
}

/**
 * Converts a corrupt persisted row into a safe, reviewable placeholder. The
 * original input remains in ImportItem.raw for diagnosis, while every API read
 * can still render the job and let the owner rematch or exclude the row.
 */
export function safeStagedNormalized(
  value: unknown,
  rowNumber: number,
): { data: StagedNormalized; valid: boolean } {
  const parsed = stagedNormalizedSchema.safeParse(value);
  if (parsed.success) return { data: parsed.data, valid: true };

  const normalizedRecord = recordValue(value);
  const parsedRecord = recordValue(normalizedRecord.parsed);
  const source = boundedText(parsedRecord.source, 200, "upload");
  const name = boundedText(parsedRecord.name, 500, `Invalid row ${rowNumber}`);
  const releaseDateTextValue = parsedRecord.releaseDateText;
  const releaseDateText =
    typeof releaseDateTextValue === "string"
      ? releaseDateTextValue.slice(0, 200)
      : null;
  const releaseDateValue = parsedRecord.releaseDate;
  const releaseDate =
    typeof releaseDateValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(releaseDateValue)
      ? releaseDateValue
      : null;
  const status =
    parsedRecord.status === "WATCHED" ||
    parsedRecord.status === "PARTIALLY_WATCHED" ||
    parsedRecord.status === "UNWATCHED"
      ? parsedRecord.status
      : "UNWATCHED";
  const languageValue = parsedRecord.languageHint;
  const languageHint =
    typeof languageValue === "string" && languageValue.trim().length >= 2
      ? languageValue.trim().slice(0, 24)
      : null;
  // Salvage the owner-supplied extras on the same terms as the fields above:
  // keep each one only when it is individually well-formed, so a row corrupted
  // elsewhere doesn't cost a rating or a watch date the file really carried.
  const ratingValue = parsedRecord.rating;
  const rating =
    typeof ratingValue === "number" && ratingValue >= 0.5 && ratingValue <= 10
      ? ratingValue
      : null;
  const watchedAtValue = parsedRecord.watchedAt;
  const watchedAt =
    typeof watchedAtValue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(watchedAtValue)
      ? watchedAtValue
      : null;

  const fallback = stagedNormalizedSchema.parse({
    parsed: {
      source,
      mediaType: parsedRecord.mediaType === "tv" ? "tv" : "movie",
      name,
      releaseDateText,
      releaseDate,
      status,
      languageHint,
      rating,
      ratingText: boundedText(parsedRecord.ratingText, 40) || null,
      watchedAt,
    },
    proposed: null,
  });
  return { data: fallback, valid: false };
}



export interface ActionPlanItem {
  id: string;
  rowNumber: number;
  action: ImportItemAction;
  proposedTmdbId: number | null;
  proposedMediaType: "MOVIE" | "TV" | null;
  excluded: boolean;
  locked?: boolean;
  titleId?: string | null;
}

function candidateYear(candidate: TmdbSearchItem): number | null {
  const value = candidate.release_date ?? candidate.first_air_date;
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function parsedYear(parsed: ParsedTitle): number | null {
  if (!parsed.releaseDate) return null;
  const year = Number(parsed.releaseDate.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

/** A stable 0..1 confidence for the review UI; it never decides the match itself. */
export function scoreImportMatch(parsed: ParsedTitle, candidate: TmdbSearchItem): number {
  const left = norm(parsed.name);
  // The localized and the original title both count, as they do in pickBest.
  const names = resultNames(candidate);
  const exact = left.length > 0 && names.includes(left);
  const partial =
    left.length > 0 && names.some((right) => left.includes(right) || right.includes(left));
  const leftYear = parsedYear(parsed);
  const rightYear = candidateYear(candidate);
  const yearDiff =
    leftYear !== null && rightYear !== null ? Math.abs(leftYear - rightYear) : null;

  let score = exact ? 0.84 : partial ? 0.64 : 0.5;
  if (yearDiff === 0) score += 0.14;
  else if (yearDiff === 1) score += 0.07;
  else if (yearDiff !== null && yearDiff > 2) score -= 0.12;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

export function proposedMatchFromTmdb(candidate: TmdbSearchItem): ProposedImportMatch {
  return {
    tmdbId: candidate.id,
    mediaType: candidate.media_type === "tv" ? "tv" : "movie",
    name: candidate.title ?? candidate.name ?? "Untitled",
    year: (candidate.release_date ?? candidate.first_air_date ?? "").slice(0, 4),
    posterPath: candidate.poster_path ?? null,
  };
}

export function proposalKey(
  mediaType: "MOVIE" | "TV" | null,
  tmdbId: number | null,
): string | null {
  return mediaType !== null && tmdbId !== null ? `${mediaType}:${tmdbId}` : null;
}

/**
 * Reconciles review actions deterministically. The first row for a TMDB identity
 * wins; later duplicates become conflicts until the owner excludes or rematches
 * them. Existing library identities are updates, all other matches are creates.
 */
export function planImportActions(
  items: ActionPlanItem[],
  existingKeys: ReadonlySet<string>,
): Map<string, { action: ImportItemAction; warning: string | null }> {
  const used = new Set<string>();
  const plan = new Map<string, { action: ImportItemAction; warning: string | null }>();

  for (const item of [...items].sort((a, b) => a.rowNumber - b.rowNumber)) {
    if (item.titleId || item.locked) {
      plan.set(item.id, { action: item.action, warning: null });
      continue;
    }
    if (item.excluded) {
      plan.set(item.id, { action: "SKIP", warning: null });
      continue;
    }
    const key = proposalKey(item.proposedMediaType, item.proposedTmdbId);
    if (!key) {
      plan.set(item.id, {
        action: "CONFLICT",
        warning: "No confident TMDB match. Choose a match or exclude this row.",
      });
      continue;
    }
    if (used.has(key)) {
      plan.set(item.id, {
        action: "CONFLICT",
        warning: "Another row in this import uses the same TMDB title.",
      });
      continue;
    }
    used.add(key);
    plan.set(item.id, {
      action: existingKeys.has(key) ? "UPDATE" : "CREATE",
      warning: null,
    });
  }
  return plan;
}


export function deriveImportJobStatus(
  items: Array<{ action: ImportItemAction; titleId: string | null; attempts: number }>,
): "COMMITTING" | "COMPLETED" | "PARTIAL" {
  if (items.some((item) => !isTerminalImportItem(item))) return "COMMITTING";
  return items.some((item) => item.action === "CONFLICT" || item.action === "FAILED")
    ? "PARTIAL"
    : "COMPLETED";
}
