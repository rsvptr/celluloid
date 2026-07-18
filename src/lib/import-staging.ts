import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { addFromTmdb, rematchTitle } from "@/lib/actions";
import { mapLimit } from "@/lib/async";
import { searchByType } from "@/lib/tmdb";
import { pickBest } from "@/lib/tmdb-match";
import type { ParsedTitle } from "@/lib/import/parse-excel";
import {
  deriveImportJobStatus,
  IMPORT_COMMIT_BATCH_SIZE,
  IMPORT_MAX_ATTEMPTS,
  INVALID_STAGED_ROW_ERROR,
  INVALID_STAGED_ROW_WARNING,
  parsedTitleSchema,
  planImportActions,
  proposedMatchFromTmdb,
  safeStagedNormalized,
  scoreImportMatch,
  stagedNormalizedSchema,
  type ProposedImportMatch,
  type StagedImportItemView,
  type StagedImportJobView,
} from "@/lib/import-staging-format";

type JobWithItems = Awaited<ReturnType<typeof findImportJob>>;

function parsedYear(parsed: ParsedTitle): number | null {
  if (!parsed.releaseDate) return null;
  const year = Number(parsed.releaseDate.slice(0, 4));
  return Number.isFinite(year) ? year : null;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function summaryRecord(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function findImportJob(userId: string, jobId: string) {
  return prisma.importJob.findFirst({
    where: { id: jobId, userId },
    include: { items: { orderBy: { rowNumber: "asc" } } },
  });
}

export function serializeImportJob(job: NonNullable<JobWithItems>): StagedImportJobView {
  return {
    id: job.id,
    filename: job.filename,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    committedAt: job.committedAt?.toISOString() ?? null,
    summary: summaryRecord(job.summary),
    items: job.items.map((item): StagedImportItemView => {
      const normalized = safeStagedNormalized(item.normalized, item.rowNumber);
      const invalid = !normalized.valid || item.errorCode === INVALID_STAGED_ROW_ERROR;
      return {
        id: item.id,
        rowNumber: item.rowNumber,
        parsed: normalized.data.parsed,
        proposed: normalized.data.proposed,
        matchScore: item.matchScore,
        action: invalid && item.action !== "SKIP" ? "CONFLICT" : item.action,
        titleId: item.titleId,
        errorCode: invalid ? INVALID_STAGED_ROW_ERROR : item.errorCode,
        warning: invalid ? INVALID_STAGED_ROW_WARNING : item.warning,
        attempts: item.attempts,
      };
    }),
  };
}

export async function getImportJobView(
  userId: string,
  jobId: string,
): Promise<StagedImportJobView | null> {
  const job = await findImportJob(userId, jobId);
  return job ? serializeImportJob(job) : null;
}

export async function getActiveImportJobView(
  userId: string,
): Promise<StagedImportJobView | null> {
  const job = await prisma.importJob.findFirst({
    where: {
      userId,
      status: { in: ["PARSING", "READY_FOR_REVIEW", "COMMITTING", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    include: { items: { orderBy: { rowNumber: "asc" } } },
  });
  return job ? serializeImportJob(job) : null;
}

async function existingProposalKeys(
  userId: string,
  proposals: Array<{ proposedTmdbId: number | null; proposedMediaType: "MOVIE" | "TV" | null }>,
) {
  const movieIds = proposals
    .filter((item) => item.proposedMediaType === "MOVIE")
    .map((item) => item.proposedTmdbId)
    .filter((id): id is number => id !== null);
  const tvIds = proposals
    .filter((item) => item.proposedMediaType === "TV")
    .map((item) => item.proposedTmdbId)
    .filter((id): id is number => id !== null);
  const existing = await prisma.title.findMany({
    where: {
      userId,
      OR: [
        ...(movieIds.length > 0 ? [{ mediaType: "MOVIE" as const, tmdbId: { in: movieIds } }] : []),
        ...(tvIds.length > 0 ? [{ mediaType: "TV" as const, tmdbId: { in: tvIds } }] : []),
      ],
    },
    select: { mediaType: true, tmdbId: true },
  });
  return new Set(existing.map((title) => `${title.mediaType}:${title.tmdbId}`));
}

export async function reconcileImportActions(userId: string, jobId: string) {
  const job = await findImportJob(userId, jobId);
  if (!job) return null;
  const invalidItemIds = new Set(
    job.items
      .filter(
        (item) =>
          item.errorCode === INVALID_STAGED_ROW_ERROR ||
          !stagedNormalizedSchema.safeParse(item.normalized).success,
      )
      .map((item) => item.id),
  );
  const existingKeys = await existingProposalKeys(userId, job.items);
  const plan = planImportActions(
    job.items.map((item) => ({
      id: item.id,
      rowNumber: item.rowNumber,
      action: item.action,
      proposedTmdbId: invalidItemIds.has(item.id) ? null : item.proposedTmdbId,
      proposedMediaType: invalidItemIds.has(item.id) ? null : item.proposedMediaType,
      excluded: item.action === "SKIP",
      locked: item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS,
      titleId: item.titleId,
    })),
    existingKeys,
  );

  await prisma.$transaction(async (tx) => {
    for (const item of job.items) {
      // Produced titles and exhausted failures are terminal audit records. A
      // different row's review edit must not erase their warning/errorCode.
      if (
        item.titleId ||
        (item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS)
      ) {
        continue;
      }
      const next = plan.get(item.id);
      const invalid = invalidItemIds.has(item.id) && next?.action !== "SKIP";
      const nextWarning = invalid ? INVALID_STAGED_ROW_WARNING : next?.warning;
      const nextErrorCode = invalid ? INVALID_STAGED_ROW_ERROR : null;
      if (
        !next ||
        (next.action === item.action &&
          nextWarning === item.warning &&
          nextErrorCode === item.errorCode)
      ) {
        continue;
      }
      await tx.importItem.update({
        where: { id: item.id },
        data: {
          action: next.action,
          warning: nextWarning,
          errorCode: nextErrorCode,
        },
      });
    }
  });
  return getImportJobView(userId, jobId);
}

export async function stageParsedImport(input: {
  userId: string;
  jobId: string;
  parsed: ParsedTitle[];
  summary: Record<string, unknown>;
}): Promise<StagedImportJobView> {
  const matched = await mapLimit(
    input.parsed.map((parsed, index) => ({ parsed, rowNumber: index + 1 })),
    6,
    async ({ parsed, rowNumber }) => {
      const validated = parsedTitleSchema.safeParse(parsed);
      if (!validated.success) {
        const normalized = safeStagedNormalized({ parsed, proposed: null }, rowNumber);
        return {
          raw: parsed,
          parsed: normalized.data.parsed,
          proposed: null,
          score: null,
          invalid: true,
        };
      }

      const validParsed = validated.data;
      try {
        const results = await searchByType(validParsed.mediaType, validParsed.name);
        const best = pickBest(results, validParsed.name, parsedYear(validParsed));
        return {
          raw: parsed,
          parsed: validParsed,
          proposed: best ? proposedMatchFromTmdb(best) : null,
          score: best ? scoreImportMatch(validParsed, best) : null,
          invalid: false,
        };
      } catch (error) {
        console.error(`Staged import match failed for ${validParsed.name}:`, error);
        return {
          raw: parsed,
          parsed: validParsed,
          proposed: null,
          score: null,
          invalid: false,
        };
      }
    },
  );

  await prisma.importItem.createMany({
    data: matched.map((item, index) => ({
      jobId: input.jobId,
      rowNumber: index + 1,
      raw: asJson(item.raw),
      normalized: asJson({ parsed: item.parsed, proposed: item.proposed }),
      proposedTmdbId: item.proposed?.tmdbId ?? null,
      proposedMediaType:
        item.proposed?.mediaType === "tv"
          ? "TV"
          : item.proposed?.mediaType === "movie"
            ? "MOVIE"
            : null,
      matchScore: item.score,
      action: item.invalid || !item.proposed ? "CONFLICT" : "CREATE",
      errorCode: item.invalid ? INVALID_STAGED_ROW_ERROR : null,
      warning: item.invalid
        ? INVALID_STAGED_ROW_WARNING
        : item.proposed
          ? null
          : "No confident TMDB match. Choose a match or exclude this row.",
    })),
  });
  await prisma.importJob.update({
    where: { id: input.jobId },
    data: { status: "READY_FOR_REVIEW", summary: asJson(input.summary) },
  });
  const job = await reconcileImportActions(input.userId, input.jobId);
  if (!job) throw new Error("Staged import job disappeared after creation.");
  return job;
}

export async function updateImportItemReview(input: {
  userId: string;
  jobId: string;
  itemId: string;
  exclude?: boolean;
  proposed?: ProposedImportMatch;
  retry?: boolean;
}): Promise<StagedImportJobView | null> {
  const item = await prisma.importItem.findFirst({
    where: {
      id: input.itemId,
      jobId: input.jobId,
      job: { userId: input.userId, status: { in: ["READY_FOR_REVIEW", "PARTIAL"] } },
    },
  });
  if (!item || item.titleId) return null;

  if (input.exclude) {
    await prisma.importItem.update({
      where: { id: item.id },
      data: { action: "SKIP", errorCode: null, warning: null },
    });
  } else {
    const normalized = safeStagedNormalized(item.normalized, item.rowNumber).data;
    const proposed = input.proposed ?? normalized.proposed;
    await prisma.importItem.update({
      where: { id: item.id },
      data: {
        normalized: asJson({ ...normalized, proposed }),
        proposedTmdbId: proposed?.tmdbId ?? null,
        proposedMediaType:
          proposed?.mediaType === "tv"
            ? "TV"
            : proposed?.mediaType === "movie"
              ? "MOVIE"
              : null,
        matchScore: input.proposed ? 1 : item.matchScore,
        action: proposed ? "CREATE" : "CONFLICT",
        errorCode: null,
        warning: null,
        attempts: input.retry || input.proposed ? 0 : item.attempts,
      },
    });
  }

  await prisma.importJob.updateMany({
    where: { id: input.jobId, userId: input.userId, status: { in: ["PARTIAL", "FAILED"] } },
    data: { status: "READY_FOR_REVIEW", committedAt: null },
  });
  return reconcileImportActions(input.userId, input.jobId);
}

function statusForParsed(parsed: ParsedTitle): "WATCHLIST" | "WATCHING" | "WATCHED" {
  if (parsed.status === "WATCHED") return "WATCHED";
  if (parsed.status === "PARTIALLY_WATCHED") return "WATCHING";
  return "WATCHLIST";
}

/**
 * Seat a freshly created import title's personal status and source. Movies (and
 * any non-watched import) take the plain single-row write. A TV title imported as
 * WATCHED must be episode-backed: addFromTmdb creates every episode unwatched, so
 * writing status = WATCHED alone would leave a 0/N "watched" show that demotes to
 * WATCHING the first time the owner ticks an episode (recomputeProgress recounts
 * from the rows). Mark every episode watched — with no date, since the import
 * format carries none — sync watchedEpisodes to the real count, then derive the
 * status from those rows. Runs under a Title-FOR-UPDATE-first lock (the same
 * order every write in this app takes) so a concurrent episode toggle's recompute
 * can't interleave. Mirrors run-import's markWatched/deriveStatus contract while
 * deliberately leaving WatchEvents absent (agreed: the format has no dates).
 */
async function applyStagedStatus(
  userId: string,
  titleId: string,
  dbMediaType: "MOVIE" | "TV",
  parsed: ParsedTitle,
): Promise<void> {
  const status = statusForParsed(parsed);
  if (dbMediaType !== "TV" || status !== "WATCHED") {
    await prisma.title.updateMany({
      where: { id: titleId, userId },
      data: { status, source: parsed.source },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    if (!rows[0]) return; // title removed concurrently
    // Mark every episode watched (no date — the import format carries none), then
    // sync the denormalized counter to the real count.
    await tx.episode.updateMany({
      where: { season: { titleId } },
      data: { watched: true, watchedAt: null },
    });
    const total = await tx.episode.count({ where: { season: { titleId } } });
    await tx.title.update({
      where: { id: titleId },
      data: {
        source: parsed.source,
        watchedEpisodes: total,
        // Episode-backed status. With every episode now watched, run-import's
        // deriveStatus(WATCHED, total, total) resolves to WATCHED whether or not
        // the show has episodes, so `status` is already WATCHED here (narrowed
        // by the guard above). Writing it from that reconciled state — not blindly
        // from the sheet at 0/N — is what stops the first episode toggle's
        // recompute from demoting the show to WATCHING.
        status,
      },
    });
  });
}

async function commitOneImportItem(userId: string, itemId: string) {
  const item = await prisma.importItem.findFirst({
    where: { id: itemId, job: { userId } },
  });
  if (!item || item.titleId || item.action === "SKIP" || item.action === "CONFLICT") return;
  if (item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS) return;

  const normalizedResult = stagedNormalizedSchema.safeParse(item.normalized);
  if (!normalizedResult.success) {
    await prisma.importItem.update({
      where: { id: item.id },
      data: {
        action: "CONFLICT",
        errorCode: INVALID_STAGED_ROW_ERROR,
        warning: INVALID_STAGED_ROW_WARNING,
      },
    });
    return;
  }
  const normalized = normalizedResult.data;
  const proposed = normalized.proposed;
  if (!proposed) {
    await prisma.importItem.update({
      where: { id: item.id },
      data: {
        action: "CONFLICT",
        warning: "No confident TMDB match. Choose a match or exclude this row.",
      },
    });
    return;
  }

  const mediaType = proposed.mediaType;
  const dbMediaType = mediaType === "tv" ? "TV" : "MOVIE";
  const existing = await prisma.title.findUnique({
    where: {
      userId_mediaType_tmdbId: {
        userId,
        mediaType: dbMediaType,
        tmdbId: proposed.tmdbId,
      },
    },
    select: { id: true, deletedAt: true },
  });

  try {
    let titleId: string | undefined;
    let action: "CREATE" | "UPDATE" = existing ? "UPDATE" : "CREATE";
    let warning: string | null = null;
    if (existing) {
      if (existing.deletedAt) {
        // Re-adding a trashed identity is a restore, not a metadata refresh that
        // leaves the title invisible. Reuse the canonical restore path so the
        // owner's personal data is preserved and all relevant pages revalidate.
        const result = await addFromTmdb(proposed.tmdbId, mediaType);
        if (result.error || !result.id) throw new Error(result.error ?? "Title was not restored.");
        titleId = result.id;
        warning = "Restored from Trash.";
      } else {
        const result = await rematchTitle(existing.id, proposed.tmdbId, mediaType);
        if (result.error) throw new Error(result.error);
        titleId = existing.id;
      }
    } else {
      const result = await addFromTmdb(proposed.tmdbId, mediaType);
      if (result.error || !result.id) throw new Error(result.error ?? "Title was not created.");
      titleId = result.id;
      action = result.existing ? "UPDATE" : "CREATE";
      warning = result.warning ?? null;
      if (!result.existing) {
        await applyStagedStatus(userId, titleId, dbMediaType, normalized.parsed);
      }
    }

    await prisma.importItem.update({
      where: { id: item.id },
      data: {
        titleId,
        action,
        warning,
        errorCode: null,
        attempts: { increment: 1 },
      },
    });
  } catch (error) {
    console.error(`Staged import commit failed for ${normalized.parsed.name}:`, error);
    await prisma.importItem.update({
      where: { id: item.id },
      data: {
        action: "FAILED",
        errorCode: "IMPORT_WRITE_FAILED",
        warning: "Celluloid couldn't save this title. Retry after checking the match.",
        attempts: { increment: 1 },
      },
    });
  }
}

async function refreshJobOutcome(userId: string, jobId: string) {
  const job = await findImportJob(userId, jobId);
  if (!job) return null;
  if (job.status === "CANCELLED") return serializeImportJob(job);
  const status = deriveImportJobStatus(job.items);
  const counts = {
    total: job.items.length,
    created: job.items.filter((item) => item.titleId && item.action === "CREATE").length,
    updated: job.items.filter((item) => item.titleId && item.action === "UPDATE").length,
    skipped: job.items.filter((item) => item.action === "SKIP").length,
    conflicts: job.items.filter((item) => item.action === "CONFLICT").length,
    failed: job.items.filter(
      (item) => item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS,
    ).length,
  };
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status,
      summary: asJson({ ...(summaryRecord(job.summary) ?? {}), ...counts }),
      committedAt: status === "COMPLETED" || status === "PARTIAL" ? new Date() : null,
    },
  });
  return getImportJobView(userId, jobId);
}

export async function commitImportJobChunk(
  userId: string,
  jobId: string,
): Promise<StagedImportJobView | null> {
  const job = await findImportJob(userId, jobId);
  if (!job) return null;
  if (
    job.status !== "READY_FOR_REVIEW" &&
    job.status !== "COMMITTING" &&
    job.status !== "PARTIAL"
  ) {
    return serializeImportJob(job);
  }
  await prisma.importJob.update({ where: { id: job.id }, data: { status: "COMMITTING" } });

  const candidates = job.items
    .filter(
      (item) =>
        !item.titleId &&
        (item.action === "CREATE" ||
          item.action === "UPDATE" ||
          (item.action === "FAILED" && item.attempts < IMPORT_MAX_ATTEMPTS)),
    )
    .slice(0, IMPORT_COMMIT_BATCH_SIZE);
  for (const item of candidates) {
    const state = await prisma.importJob.findFirst({
      where: { id: job.id, userId },
      select: { status: true },
    });
    if (!state || state.status === "CANCELLED") break;
    await commitOneImportItem(userId, item.id);
  }
  return refreshJobOutcome(userId, jobId);
}

export async function cancelImportJob(userId: string, jobId: string): Promise<boolean> {
  const result = await prisma.importJob.updateMany({
    where: { id: jobId, userId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  return result.count > 0;
}
