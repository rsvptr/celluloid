import { z } from "zod";
import { WATCH_REGIONS } from "@/lib/tmdb-extras";
import { WITHDRAWN_EPISODE_NUMBER_OFFSET } from "@/lib/rematch-history";

export const BACKUP_APP = "celluloid" as const;
export const BACKUP_SCHEMA_VERSION = 2 as const;
export const BACKUP_V1_SCHEMA_VERSION = 1 as const;
// Vercel's serverless function body cap is ~4.5 MB, so anything past 4 MB
// never reaches this handler; keep the declared cap under that ceiling.
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;

const timestampSchema = z.string().datetime({ offset: true }).max(40);
const nullableTimestampSchema = timestampSchema.nullable();
const sourceIdSchema = z.string().min(1).max(64);
const nullableText = (max: number) => z.string().max(max).nullable();
const nullableInt = z.number().int().nullable();

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function normalizeTagName(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

export const backupEpisodeSchema = z
  .object({
    sourceId: sourceIdSchema,
    tmdbId: nullableInt,
    episodeNumber: z
      .number()
      .int()
      .min(0)
      .max(WITHDRAWN_EPISODE_NUMBER_OFFSET + 100_000),
    name: nullableText(500),
    // TMDB-derived prose is omitted from new backups for size, but remains
    // optional so older v2 files that carried it continue to parse.
    overview: nullableText(200_000).optional(),
    airDate: nullableTimestampSchema,
    runtime: z.number().int().min(0).max(100_000).nullable(),
    stillPath: nullableText(1_000).optional(),
    watched: z.boolean(),
    watchedAt: nullableTimestampSchema,
    // Optional for backups created before withdrawn episodes had an explicit marker.
    withdrawnAt: nullableTimestampSchema.optional().default(null),
  })
  .strict()
  .superRefine((episode, ctx) => {
    if (!episode.watched && episode.watchedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["watchedAt"],
        message: "unwatched episodes cannot have a watched timestamp",
      });
    }
  });

export const backupSeasonSchema = z
  .object({
    sourceId: sourceIdSchema,
    tmdbId: nullableInt,
    seasonNumber: z.number().int().min(0).max(10_000),
    name: nullableText(500),
    // Re-fetchable from TMDB after restore; optional preserves old v2 input.
    overview: nullableText(200_000).optional(),
    airDate: nullableTimestampSchema,
    posterPath: nullableText(1_000),
    episodeCount: z.number().int().min(0).max(100_000).nullable(),
    episodes: z.array(backupEpisodeSchema).max(5_000),
  })
  .strict()
  .superRefine((season, ctx) => {
    const numbers = new Set<number>();
    for (const [index, episode] of season.episodes.entries()) {
      if (numbers.has(episode.episodeNumber)) {
        ctx.addIssue({
          code: "custom",
          path: ["episodes", index, "episodeNumber"],
          message: "duplicate episode number",
        });
      }
      numbers.add(episode.episodeNumber);
    }
  });

const backupTitleFields = {
  sourceId: sourceIdSchema,
  tmdbId: nullableInt,
  mediaType: z.enum(["MOVIE", "TV"]),
  name: z.string().min(1).max(500),
  originalName: nullableText(500),
  overview: nullableText(200_000),
  releaseDate: nullableTimestampSchema,
  posterPath: nullableText(1_000),
  backdropPath: nullableText(1_000),
  language: nullableText(24),
  tmdbRating: z.number().min(0).max(10).nullable(),
  runtime: z.number().int().min(0).max(100_000).nullable(),
  genres: z.array(z.string().min(1).max(100)).max(100),
  status: z.enum(["WATCHLIST", "WATCHING", "WATCHED", "ON_HOLD", "DROPPED"]),
  rating: z.number().min(0).max(10).nullable(),
  notes: nullableText(2_000_000),
  watchedAt: nullableTimestampSchema,
  favorite: z.boolean(),
  totalSeasons: z.number().int().min(0).max(100_000).nullable(),
  totalEpisodes: z.number().int().min(0).max(1_000_000).nullable(),
  watchedEpisodes: z.number().int().min(0).max(1_000_000),
  source: nullableText(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  seasons: z.array(backupSeasonSchema).max(1_000),
  tags: z.array(z.string().min(1).max(200)).max(1_000),
};

function refineBackupTitle(
  title: {
    rating: number | null;
    totalEpisodes: number | null;
    watchedEpisodes: number;
    seasons: Array<{ seasonNumber: number }>;
    tags: string[];
  },
  ctx: z.RefinementCtx,
) {
    if (
      title.rating !== null &&
      (title.rating < 0.5 || !Number.isInteger(title.rating * 2))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["rating"],
        message: "rating must be between 0.5 and 10 in half-point steps",
      });
    }
    if (
      title.totalEpisodes !== null &&
      title.watchedEpisodes > title.totalEpisodes
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["watchedEpisodes"],
        message: "watched episode count cannot exceed total episodes",
      });
    }

    const seasonNumbers = new Set<number>();
    for (const [index, season] of title.seasons.entries()) {
      if (seasonNumbers.has(season.seasonNumber)) {
        ctx.addIssue({
          code: "custom",
          path: ["seasons", index, "seasonNumber"],
          message: "duplicate season number",
        });
      }
      seasonNumbers.add(season.seasonNumber);
    }
    if (new Set(title.tags.map(normalizeTagName)).size !== title.tags.length) {
      ctx.addIssue({ code: "custom", path: ["tags"], message: "duplicate tag name" });
    }
}

const backupTitleV1Schema = z
  .object(backupTitleFields)
  .strict()
  .superRefine(refineBackupTitle);

export const backupTitleSchema = z
  .object({ ...backupTitleFields, deletedAt: nullableTimestampSchema })
  .strict()
  .superRefine(refineBackupTitle);

export const backupTagSchema = z
  .object({
    sourceId: sourceIdSchema,
    name: z.string().min(1).max(200),
    color: nullableText(100),
    createdAt: timestampSchema,
  })
  .strict();

const backupShareV1Schema = z
  .object({
    sourceId: sourceIdSchema,
    name: nullableText(200),
    titleIds: z.array(sourceIdSchema).max(20_000),
    includeNotes: z.boolean(),
    includeWatchlist: z.boolean(),
    createdAt: timestampSchema,
  })
  .strict();

export const backupShareItemSchema = z
  .object({
    titleId: sourceIdSchema,
    position: z.number().int().min(1).max(20_000),
  })
  .strict();

export const backupShareSchema = z
  .object({
    sourceId: sourceIdSchema,
    name: nullableText(200),
    titleIds: z.array(sourceIdSchema).max(20_000),
    includeNotes: z.boolean(),
    includeWatchlist: z.boolean(),
    scope: z.enum(["WHOLE_LIBRARY", "SELECTION"]),
    expiresAt: nullableTimestampSchema,
    revokedAt: nullableTimestampSchema,
    items: z.array(backupShareItemSchema).max(20_000),
    createdAt: timestampSchema,
  })
  .strict();

export const backupWatchEventSchema = z
  .object({
    sourceId: sourceIdSchema,
    titleId: sourceIdSchema,
    episodeId: sourceIdSchema.nullable(),
    kind: z.enum(["TITLE_COMPLETED", "EPISODE_WATCHED", "REWATCH"]),
    occurredAt: timestampSchema,
    source: z.enum(["MANUAL", "BULK", "IMPORT", "RESTORE", "BACKFILL"]),
    note: nullableText(20_000),
    createdAt: timestampSchema,
  })
  .strict();

export const backupSuppressionSchema = z
  .object({
    sourceId: sourceIdSchema,
    matchKey: z.string().min(1).max(1_000),
    tmdbId: z.number().int().positive().nullable(),
    mediaType: z.enum(["MOVIE", "TV"]),
    name: z.string().trim().min(1).max(500),
    year: z.number().int().min(0).max(9_999).nullable(),
    reason: z.enum(["NOT_INTERESTED", "SEEN_ELSEWHERE"]),
    createdAt: timestampSchema,
  })
  .strict();

export const backupUserSchema = z
  .object({
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .refine(isValidTimeZone, "invalid IANA time zone"),
    watchRegion: z.enum(WATCH_REGIONS),
    // Optional rather than defaulted so a pre-CEL-6 v2 backup remains
    // distinguishable from a newer backup that deliberately stores an empty
    // selection or the default recommendation model. Restore can then leave
    // preferences that the older file never represented untouched.
    myProviders: z
      .array(z.number().int().positive().max(2_147_483_647))
      .max(100)
      .optional(),
    recommendModel: nullableText(200).optional(),
  })
  .strict();

type EnvelopeForRefinement = {
  titles: Array<z.infer<typeof backupTitleV1Schema> | z.infer<typeof backupTitleSchema>>;
  tags: Array<z.infer<typeof backupTagSchema>>;
  shares: Array<
    z.infer<typeof backupShareV1Schema> | z.infer<typeof backupShareSchema>
  >;
  watchEvents?: Array<z.infer<typeof backupWatchEventSchema>>;
  suppressions?: Array<z.infer<typeof backupSuppressionSchema>>;
};

function refineBackupEnvelope(backup: EnvelopeForRefinement, ctx: z.RefinementCtx) {
  const titleIds = new Set<string>();
  const titleTmdbIds = new Set<string>();
  const episodeOwners = new Map<string, string>();
  for (const [index, title] of backup.titles.entries()) {
    if (titleIds.has(title.sourceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["titles", index, "sourceId"],
        message: "duplicate title sourceId",
      });
    }
    titleIds.add(title.sourceId);

    if (title.tmdbId !== null) {
      const tmdbKey = `${title.mediaType}:${title.tmdbId}`;
      if (titleTmdbIds.has(tmdbKey)) {
        ctx.addIssue({
          code: "custom",
          path: ["titles", index, "tmdbId"],
          message: "duplicate media type and TMDB id",
        });
      }
      titleTmdbIds.add(tmdbKey);
    }
    for (const season of title.seasons) {
      for (const episode of season.episodes) {
        if (episodeOwners.has(episode.sourceId)) {
          ctx.addIssue({
            code: "custom",
            path: ["titles", index, "seasons"],
            message: "duplicate episode sourceId",
          });
        }
        episodeOwners.set(episode.sourceId, title.sourceId);
      }
    }
  }

  const tagIds = new Set<string>();
  const tagNames = new Set<string>();
  for (const [index, tag] of backup.tags.entries()) {
    if (tagIds.has(tag.sourceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["tags", index, "sourceId"],
        message: "duplicate tag sourceId",
      });
    }
    const normalizedName = normalizeTagName(tag.name);
    if (tagNames.has(normalizedName)) {
      ctx.addIssue({
        code: "custom",
        path: ["tags", index, "name"],
        message: "duplicate tag name",
      });
    }
    tagIds.add(tag.sourceId);
    tagNames.add(normalizedName);
  }

  for (const [titleIndex, title] of backup.titles.entries()) {
    for (const [tagIndex, tagName] of title.tags.entries()) {
      if (!tagNames.has(normalizeTagName(tagName))) {
        ctx.addIssue({
          code: "custom",
          path: ["titles", titleIndex, "tags", tagIndex],
          message: "references a tag missing from the backup tag list",
        });
      }
    }
  }

  const shareIds = new Set<string>();
  for (const [shareIndex, share] of backup.shares.entries()) {
    if (shareIds.has(share.sourceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["shares", shareIndex, "sourceId"],
        message: "duplicate share sourceId",
      });
    }
    shareIds.add(share.sourceId);
    for (const [titleIndex, titleId] of share.titleIds.entries()) {
      if (!titleIds.has(titleId)) {
        ctx.addIssue({
          code: "custom",
          path: ["shares", shareIndex, "titleIds", titleIndex],
          message: "references a title missing from the backup",
        });
      }
    }
    if ("items" in share) {
      const itemTitleIds = new Set<string>();
      const positions = new Set<number>();
      for (const [itemIndex, item] of share.items.entries()) {
        if (!titleIds.has(item.titleId)) {
          ctx.addIssue({
            code: "custom",
            path: ["shares", shareIndex, "items", itemIndex, "titleId"],
            message: "references a title missing from the backup",
          });
        }
        if (itemTitleIds.has(item.titleId) || positions.has(item.position)) {
          ctx.addIssue({
            code: "custom",
            path: ["shares", shareIndex, "items", itemIndex],
            message: "duplicate share item title or position",
          });
        }
        itemTitleIds.add(item.titleId);
        positions.add(item.position);
        if (share.titleIds[itemIndex] !== item.titleId || item.position !== itemIndex + 1) {
          ctx.addIssue({
            code: "custom",
            path: ["shares", shareIndex, "items", itemIndex],
            message: "share items must match titleIds in contiguous curated order",
          });
        }
      }
      if (share.items.length !== share.titleIds.length) {
        ctx.addIssue({
          code: "custom",
          path: ["shares", shareIndex, "items"],
          message: "share items must match titleIds",
        });
      }
      if (share.scope === "WHOLE_LIBRARY" && share.items.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["shares", shareIndex, "scope"],
          message: "share scope does not match its curated items",
        });
      }
    }
  }

  const eventIds = new Set<string>();
  for (const [eventIndex, event] of (backup.watchEvents ?? []).entries()) {
    if (eventIds.has(event.sourceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["watchEvents", eventIndex, "sourceId"],
        message: "duplicate watch event sourceId",
      });
    }
    eventIds.add(event.sourceId);
    if (!titleIds.has(event.titleId)) {
      ctx.addIssue({
        code: "custom",
        path: ["watchEvents", eventIndex, "titleId"],
        message: "references a title missing from the backup",
      });
    }
    if (event.episodeId !== null && episodeOwners.get(event.episodeId) !== event.titleId) {
      ctx.addIssue({
        code: "custom",
        path: ["watchEvents", eventIndex, "episodeId"],
        message: "references an episode missing from that backup title",
      });
    }
  }

  const suppressionIds = new Set<string>();
  const suppressionKeys = new Set<string>();
  for (const [index, suppression] of (backup.suppressions ?? []).entries()) {
    if (suppressionIds.has(suppression.sourceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["suppressions", index, "sourceId"],
        message: "duplicate suppression sourceId",
      });
    }
    if (suppressionKeys.has(suppression.matchKey)) {
      ctx.addIssue({
        code: "custom",
        path: ["suppressions", index, "matchKey"],
        message: "duplicate suppression matchKey",
      });
    }
    suppressionIds.add(suppression.sourceId);
    suppressionKeys.add(suppression.matchKey);
  }
}

export const backupEnvelopeSchema = z
  .object({
    app: z.literal(BACKUP_APP),
    schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
    exportedAt: timestampSchema,
    user: backupUserSchema,
    titles: z.array(backupTitleSchema).max(20_000),
    tags: z.array(backupTagSchema).max(10_000),
    shares: z.array(backupShareSchema).max(5_000),
    watchEvents: z.array(backupWatchEventSchema).max(100_000),
    // Kept optional within v2 so backups downloaded before suppressions were
    // added remain valid durable artifacts. Every newly-created envelope emits
    // this field, including when the array is empty.
    suppressions: z.array(backupSuppressionSchema).max(100_000).optional(),
  })
  .strict()
  .superRefine(refineBackupEnvelope);

export const backupV1EnvelopeSchema = z
  .object({
    app: z.literal(BACKUP_APP),
    schemaVersion: z.literal(BACKUP_V1_SCHEMA_VERSION),
    exportedAt: timestampSchema,
    titles: z.array(backupTitleV1Schema).max(20_000),
    tags: z.array(backupTagSchema).max(10_000),
    shares: z.array(backupShareV1Schema).max(5_000),
  })
  .strict()
  .superRefine(refineBackupEnvelope);

export type BackupEpisode = z.infer<typeof backupEpisodeSchema>;
export type BackupSeason = z.infer<typeof backupSeasonSchema>;
export type BackupTitle = z.infer<typeof backupTitleSchema>;
export type BackupTag = z.infer<typeof backupTagSchema>;
export type BackupShare = z.infer<typeof backupShareSchema>;
export type BackupWatchEvent = z.infer<typeof backupWatchEventSchema>;
export type BackupSuppression = z.infer<typeof backupSuppressionSchema>;
export type BackupUser = z.infer<typeof backupUserSchema>;
export type BackupEnvelope = z.infer<typeof backupEnvelopeSchema>;
export type BackupV1Envelope = z.infer<typeof backupV1EnvelopeSchema>;
export type RestoreMode = "merge" | "replace-personal";

export interface RestoreCounts {
  create: number;
  update: number;
  skip: number;
  conflict: number;
}

/** Non-title data shown in, and cryptographically bound to, a restore preview. */
export interface SupplementalRestoreCounts {
  eventsCreate: number;
  suppressionsCreate: number;
  suppressionsUpdate: number;
  suppressionsSkip: number;
  providerSelections: number;
  providerPreferenceIncluded: number;
  providerPreferenceUpdate: number;
  recommendModelPreferenceIncluded: number;
  recommendModelPreferenceUpdate: number;
}

export type RestorePreviewCounts = RestoreCounts & SupplementalRestoreCounts;

export type RestorePlanItem =
  | { action: "create"; incoming: BackupTitle }
  | { action: "update"; incoming: BackupTitle; existingId: string; merged: BackupTitle }
  | { action: "skip"; incoming: BackupTitle; existingId: string }
  | { action: "conflict"; incoming: BackupTitle };

export interface RestorePlan {
  counts: RestoreCounts;
  items: RestorePlanItem[];
}

export function upgradeBackupV1(backup: BackupV1Envelope): BackupEnvelope {
  return backupEnvelopeSchema.parse({
    app: backup.app,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: backup.exportedAt,
    user: { timeZone: "UTC", watchRegion: "US" },
    titles: backup.titles.map((title) => ({ ...title, deletedAt: null })),
    tags: backup.tags,
    shares: backup.shares.map((share) => ({
      ...share,
      scope: share.titleIds.length === 0 ? "WHOLE_LIBRARY" : "SELECTION",
      expiresAt: null,
      revokedAt: null,
      items: share.titleIds.map((titleId, index) => ({ titleId, position: index + 1 })),
    })),
    watchEvents: [],
  });
}

export const backupInputSchema = z
  .union([backupEnvelopeSchema, backupV1EnvelopeSchema])
  .transform((backup) =>
    backup.schemaVersion === BACKUP_SCHEMA_VERSION ? backup : upgradeBackupV1(backup),
  );

export function parseBackupEnvelope(value: unknown): BackupEnvelope {
  return backupInputSchema.parse(value);
}

function normalizeName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function releaseYear(value: string | null): string {
  return value?.slice(0, 4) ?? "";
}

function fillNullable<T>(current: T | null, incoming: T | null): T | null {
  return current !== null ? current : incoming;
}

function fillOptionalNullable<T>(
  current: T | null | undefined,
  incoming: T | null | undefined,
): T | null | undefined {
  return current !== null && current !== undefined ? current : incoming;
}

function mergeEpisode(
  existing: BackupEpisode,
  incoming: BackupEpisode,
  mode: RestoreMode,
): BackupEpisode {
  return {
    ...existing,
    tmdbId: fillNullable(existing.tmdbId, incoming.tmdbId),
    name: fillNullable(existing.name, incoming.name),
    overview: fillOptionalNullable(existing.overview, incoming.overview),
    airDate: fillNullable(existing.airDate, incoming.airDate),
    runtime: fillNullable(existing.runtime, incoming.runtime),
    stillPath: fillOptionalNullable(existing.stillPath, incoming.stillPath),
    watched: mode === "replace-personal" ? incoming.watched : existing.watched,
    watchedAt:
      mode === "replace-personal"
        ? incoming.watchedAt
        : existing.watched
          ? fillNullable(existing.watchedAt, incoming.watchedAt)
          : existing.watchedAt,
    withdrawnAt:
      mode === "replace-personal"
        ? incoming.withdrawnAt
        : fillNullable(existing.withdrawnAt, incoming.withdrawnAt),
  };
}

function mergeSeason(
  existing: BackupSeason,
  incoming: BackupSeason,
  mode: RestoreMode,
): BackupSeason {
  const incomingByNumber = new Map(
    incoming.episodes.map((episode) => [episode.episodeNumber, episode]),
  );
  const episodes = existing.episodes.map((episode) => {
    const incomingEpisode = incomingByNumber.get(episode.episodeNumber);
    if (!incomingEpisode) return episode;
    incomingByNumber.delete(episode.episodeNumber);
    return mergeEpisode(episode, incomingEpisode, mode);
  });
  episodes.push(...incomingByNumber.values());
  episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);

  return {
    ...existing,
    tmdbId: fillNullable(existing.tmdbId, incoming.tmdbId),
    name: fillNullable(existing.name, incoming.name),
    overview: fillOptionalNullable(existing.overview, incoming.overview),
    airDate: fillNullable(existing.airDate, incoming.airDate),
    posterPath: fillNullable(existing.posterPath, incoming.posterPath),
    episodeCount: fillNullable(existing.episodeCount, incoming.episodeCount),
    episodes,
  };
}

/** Applies the documented non-destructive or backup-authoritative personal merge. */
export function mergeBackupTitle(
  existing: BackupTitle | null,
  incoming: BackupTitle,
  mode: RestoreMode,
): BackupTitle {
  if (!existing) return structuredClone(incoming);

  const incomingByNumber = new Map(
    incoming.seasons.map((season) => [season.seasonNumber, season]),
  );
  const seasons = existing.seasons.map((season) => {
    const incomingSeason = incomingByNumber.get(season.seasonNumber);
    if (!incomingSeason) return season;
    incomingByNumber.delete(season.seasonNumber);
    return mergeSeason(season, incomingSeason, mode);
  });
  seasons.push(...incomingByNumber.values());
  seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

  // Case-insensitive union: existing casing wins on a case-only collision
  // (e.g. existing "Action" + incoming "action" survive as one "Action" tag)
  // since existing is spread first and the loop keeps only the first
  // occurrence of each normalized name.
  const seenTagNames = new Set<string>();
  const tags: string[] = [];
  if (mode === "replace-personal") {
    tags.push(...incoming.tags);
  } else {
    for (const tag of [...existing.tags, ...incoming.tags]) {
      const key = normalizeTagName(tag);
      if (seenTagNames.has(key)) continue;
      seenTagNames.add(key);
      tags.push(tag);
    }
  }
  tags.sort((a, b) => a.localeCompare(b));

  // The denormalized counters must describe the season/episode rows this merge
  // will actually persist, not whichever side happened to be non-null first.
  // `fillNullable` used to keep the EXISTING totals here, so restoring a backup
  // that adds a season left the title claiming its pre-restore episode count
  // while twice as many Episode rows existed — a permanently wrong progress bar
  // and a wrong `episodesTotal` in stats. Deriving them from `seasons` also
  // makes the plan-time preview agree with what apply writes (planRestoreTitles
  // calls this same function), so the confirmation dialog stops reporting
  // phantom updates for titles whose only "change" was a recount.
  const mergedEpisodes = seasons.flatMap((season) => season.episodes);
  const activeMergedEpisodes = mergedEpisodes.filter((episode) => episode.withdrawnAt === null);
  const hasEpisodeRows = mergedEpisodes.length > 0;
  const mergedWatchedEpisodes = activeMergedEpisodes.filter((e) => e.watched).length;
  const counterOnlyWatchedEpisodes =
    mode === "replace-personal" ? incoming.watchedEpisodes : existing.watchedEpisodes;
  const counterOnlyTotalEpisodes =
    mode === "replace-personal"
      ? incoming.totalEpisodes
      : fillNullable(existing.totalEpisodes, incoming.totalEpisodes);

  return {
    ...existing,
    tmdbId: fillNullable(existing.tmdbId, incoming.tmdbId),
    originalName: fillNullable(existing.originalName, incoming.originalName),
    overview: fillNullable(existing.overview, incoming.overview),
    releaseDate: fillNullable(existing.releaseDate, incoming.releaseDate),
    posterPath: fillNullable(existing.posterPath, incoming.posterPath),
    backdropPath: fillNullable(existing.backdropPath, incoming.backdropPath),
    language: fillNullable(existing.language, incoming.language),
    tmdbRating: fillNullable(existing.tmdbRating, incoming.tmdbRating),
    runtime: fillNullable(existing.runtime, incoming.runtime),
    genres: existing.genres.length > 0 ? existing.genres : incoming.genres,
    status: mode === "replace-personal" ? incoming.status : existing.status,
    rating:
      mode === "replace-personal"
        ? incoming.rating
        : fillNullable(existing.rating, incoming.rating),
    notes:
      mode === "replace-personal"
        ? incoming.notes
        : fillNullable(existing.notes, incoming.notes),
    watchedAt:
      mode === "replace-personal"
        ? incoming.watchedAt
        : fillNullable(existing.watchedAt, incoming.watchedAt),
    favorite: mode === "replace-personal" ? incoming.favorite : existing.favorite,
    // Never understate the season count once rows exist. TMDB's own
    // `number_of_seasons` can legitimately exceed the seasons we materialize
    // (specials are skipped), so take the larger of the two rather than
    // clobbering a known-good total with a row count.
    totalSeasons:
      seasons.length > 0
        ? Math.max(
            seasons.length,
            fillNullable(existing.totalSeasons, incoming.totalSeasons) ?? 0,
          )
        : fillNullable(existing.totalSeasons, incoming.totalSeasons),
    // Episode totals are exact: every episode row this merge persists is in
    // `seasons`, and recomputeProgress counts those same rows.
    totalEpisodes: hasEpisodeRows
      ? activeMergedEpisodes.length
      : counterOnlyTotalEpisodes === null
        ? null
        : Math.max(counterOnlyTotalEpisodes, counterOnlyWatchedEpisodes),
    watchedEpisodes: hasEpisodeRows
      ? mergedWatchedEpisodes
      : counterOnlyWatchedEpisodes,
    source: fillNullable(existing.source, incoming.source),
    // Merge must never change local trash state: a live local title stays live
    // even when the backup copy is trashed, and a trashed local title stays
    // trashed even when the backup copy is live. A nullable-fill here would let a
    // trashed backup silently soft-delete a live local title. Only replace-personal
    // (backup-authoritative) adopts the backup's deletedAt.
    deletedAt: mode === "replace-personal" ? incoming.deletedAt : existing.deletedAt,
    seasons,
    tags,
  };
}

function equivalentTitle(left: BackupTitle, right: BackupTitle): boolean {
  // Zod emits schema-key order, making the comparison independent of the
  // insertion order of objects assembled by a merge versus parsed from JSON.
  return (
    JSON.stringify(backupTitleSchema.parse(left)) ===
    JSON.stringify(backupTitleSchema.parse(right))
  );
}

/** Builds a deterministic title-level plan without touching the database. */
export function planRestoreTitles(
  incomingTitles: BackupTitle[],
  existingTitles: BackupTitle[],
  mode: RestoreMode,
): RestorePlan {
  const items: RestorePlanItem[] = [];
  const usedExistingIds = new Set<string>();
  const counts: RestoreCounts = { create: 0, update: 0, skip: 0, conflict: 0 };

  for (const incoming of incomingTitles) {
    const sourceCandidates = existingTitles.filter(
      (title) => title.sourceId === incoming.sourceId,
    );
    if (
      sourceCandidates.length === 1 &&
      !sameLogicalTitle(sourceCandidates[0], incoming)
    ) {
      counts.conflict += 1;
      items.push({ action: "conflict", incoming });
      continue;
    }
    let candidates = sourceCandidates;

    if (candidates.length === 0) {
      candidates =
        incoming.tmdbId === null
          ? []
          : existingTitles.filter(
            (title) =>
              title.mediaType === incoming.mediaType && title.tmdbId === incoming.tmdbId,
          );
    }

    if (candidates.length === 0) {
      candidates = existingTitles.filter(
        (title) =>
          title.mediaType === incoming.mediaType &&
          normalizeName(title.name) === normalizeName(incoming.name) &&
          releaseYear(title.releaseDate) === releaseYear(incoming.releaseDate) &&
          (title.tmdbId === null || incoming.tmdbId === null),
      );
    }

    if (
      candidates.length > 1 ||
      (candidates.length === 1 && usedExistingIds.has(candidates[0].sourceId))
    ) {
      counts.conflict += 1;
      items.push({ action: "conflict", incoming });
      continue;
    }

    const existing = candidates[0];
    if (!existing) {
      counts.create += 1;
      items.push({ action: "create", incoming });
      continue;
    }

    const tmdbFillWouldCollide =
      existing.tmdbId === null &&
      incoming.tmdbId !== null &&
      existingTitles.some(
        (title) =>
          title.sourceId !== existing.sourceId &&
          title.mediaType === incoming.mediaType &&
          title.tmdbId === incoming.tmdbId,
      );
    if (tmdbFillWouldCollide) {
      counts.conflict += 1;
      items.push({ action: "conflict", incoming });
      continue;
    }

    usedExistingIds.add(existing.sourceId);
    // Validate the exact row shape during planning, before restore opens any
    // write transaction. This keeps database CHECK constraints as a final
    // safeguard rather than the first place an impossible merge is discovered.
    const merged = backupTitleSchema.parse(mergeBackupTitle(existing, incoming, mode));
    if (equivalentTitle(existing, merged)) {
      counts.skip += 1;
      items.push({ action: "skip", incoming, existingId: existing.sourceId });
    } else {
      counts.update += 1;
      items.push({
        action: "update",
        incoming,
        existingId: existing.sourceId,
        merged,
      });
    }
  }

  return { counts, items };
}

function sameLogicalTitle(left: BackupTitle, right: BackupTitle): boolean {
  if (left.mediaType !== right.mediaType) return false;
  if (left.tmdbId !== null && right.tmdbId !== null) {
    return left.tmdbId === right.tmdbId;
  }
  return (
    normalizeName(left.name) === normalizeName(right.name) &&
    releaseYear(left.releaseDate) === releaseYear(right.releaseDate)
  );
}
