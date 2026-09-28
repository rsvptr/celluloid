import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { addFromTmdb, rematchTitle } from "@/lib/actions";
import { mapLimit } from "@/lib/async";
import { ACTIVE_EPISODE_FILTER } from "@/lib/rematch-history";
import {
  findByImdbId,
  findTvByTvdbId,
  getMovie,
  getTv,
  searchByType,
  type TmdbMovieDetails,
  type TmdbSearchItem,
  type TmdbTvDetails,
} from "@/lib/tmdb";
import { pickBest } from "@/lib/tmdb-match";
import type { ParsedTitle } from "@/lib/import/parse-excel";
import {
  importStatusForParsed,
  planExistingImportMerge,
  type ExistingLibraryStatus,
} from "@/lib/import-merge";
import {
  deriveImportJobStatus,
  IMPORT_COMMIT_BATCH_SIZE,
  IMPORT_MAX_ATTEMPTS,
  INVALID_STAGED_ROW_ERROR,
  INVALID_STAGED_ROW_WARNING,
  MATCH_TIMED_OUT_ERROR,
  MATCH_TIMED_OUT_WARNING,
  parsedTitleSchema,
  planImportActions,
  proposedMatchFromTmdb,
  safeStagedNormalized,
  scoreImportMatch,
  stagedNormalizedSchema,
  type ImportItemAction,
  type ProposedImportMatch,
  type StagedImportItemView,
  type StagedImportJobView,
} from "@/lib/import-staging-format";

type JobWithItems = Awaited<ReturnType<typeof findImportJob>>;

/**
 * Wall-clock budget for the TMDB matching phase, measured from the start of the
 * upload request and set well under that route's maxDuration. Matching 250 rows
 * used to run unbounded: when the platform killed the function mid-parse neither
 * the catch nor the "-> FAILED" update ran, and the job sat in PARSING forever
 * while the Add page kept offering that empty job for resume. Stopping on our
 * own terms leaves the unmatched rows individually retryable in review instead.
 */
export const IMPORT_STAGING_BUDGET_MS = 35_000;

/**
 * Wall-clock budget for one commit request. Vercel may terminate the route at
 * 60 seconds, so stop STARTING title writes after 45 seconds and leave the
 * remaining items in COMMITTING for the client's existing resumable loop.
 * The 15-second tail is deliberate headroom for the last item, outcome write,
 * serialization, and response flush.
 */
export const IMPORT_COMMIT_BUDGET_MS = 45_000;

/**
 * How long a PARSING job may sit before it is treated as the corpse of a killed
 * upload rather than work in progress. A parse only lives for the length of one
 * request, so anything older than this is never coming back.
 */
const STALE_PARSING_MS = 5 * 60_000;

/**
 * Transaction timeout for reconcileImportActions' writes. They are one
 * updateMany per distinct outcome, a handful whatever the row count, so the 5 s
 * default already fits a normal link. This triples it for a slow one (a laptop
 * on the Neon dev branch), and still leaves the staging request about 10 s of
 * the 25 s its 60 s maxDuration has left after IMPORT_STAGING_BUDGET_MS.
 */
const RECONCILE_TX_TIMEOUT_MS = 15_000;

const NO_MATCH_WARNING = "No confident TMDB match. Choose a match or exclude this row.";
const CREATED_WITHOUT_PERSONAL_FIELDS_WARNING = "Saved without its status and rating.";

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

/**
 * What review, reconcile and commit read of a job and its rows. It leaves out
 * each row's `raw` JSON, a copy of the uploaded row kept only for diagnosis,
 * which these reads loaded for every row and never used (PR-09).
 */
const importJobSelect = {
  id: true,
  filename: true,
  status: true,
  summary: true,
  createdAt: true,
  committedAt: true,
  items: {
    select: {
      id: true,
      rowNumber: true,
      normalized: true,
      proposedTmdbId: true,
      proposedMediaType: true,
      matchScore: true,
      action: true,
      titleId: true,
      errorCode: true,
      warning: true,
      attempts: true,
    },
    orderBy: { rowNumber: "asc" },
  },
} satisfies Prisma.ImportJobSelect;

async function findImportJob(userId: string, jobId: string) {
  return prisma.importJob.findFirst({
    where: { id: jobId, userId },
    select: importJobSelect,
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

/**
 * The newest job the Add page has to say something about, or null. A parse only
 * exists for the life of its upload request, which returns the staged job to the
 * browser itself, so a PARSING row here is either that request still running or
 * the wreck of one the platform killed. Both used to be offered for resume,
 * which handed review an item-less job on every visit to Add — Commit was a
 * no-op and nothing said Cancel was the only way out. The wrecks are retired as
 * FAILED on the way past so the job list stays honest, but a parse that started
 * moments ago is still returned, as PARSING: hiding it left a second tab showing
 * a clean upload form while a large file was genuinely being matched, so the
 * owner uploaded it again and got two jobs for one file. A PARSING job is
 * reported, not resumable — it carries no items to review yet.
 */
export async function getActiveImportJobView(
  userId: string,
): Promise<StagedImportJobView | null> {
  await prisma.importJob.updateMany({
    where: {
      userId,
      status: "PARSING",
      createdAt: { lt: new Date(Date.now() - STALE_PARSING_MS) },
    },
    data: { status: "FAILED", summary: asJson({ error: "STAGING_ABANDONED" }) },
  });
  const job = await prisma.importJob.findFirst({
    where: {
      userId,
      status: { in: ["PARSING", "READY_FOR_REVIEW", "COMMITTING", "PARTIAL"] },
    },
    orderBy: { createdAt: "desc" },
    select: importJobSelect,
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
  // Rows the staging deadline cut short are ordinary unmatched rows, but their
  // warning has to keep saying why. Warnings are recomputed from scratch below,
  // so without re-asserting the marker the first review edit anywhere in the job
  // would silently relabel them as "no confident match".
  const timedOutItemIds = new Set(
    job.items
      .filter(
        (item) =>
          item.errorCode === MATCH_TIMED_OUT_ERROR &&
          !item.titleId &&
          item.proposedTmdbId === null,
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

  // Staging inserts every row as CREATE, so a re-import flips most of its up to
  // 250 rows here, and one round trip per row could outrun the transaction
  // timeout (PR-03). Rows are decided before the transaction and grouped by
  // their new (action, warning, errorCode), so it holds one updateMany a group.
  const writes = new Map<
    string,
    { data: Prisma.ImportItemUpdateManyMutationInput; ids: string[] }
  >();
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
    const timedOut =
      !invalid && next?.action === "CONFLICT" && timedOutItemIds.has(item.id);
    const nextWarning = invalid
      ? INVALID_STAGED_ROW_WARNING
      : timedOut
        ? MATCH_TIMED_OUT_WARNING
        : next?.warning;
    const nextErrorCode = invalid
      ? INVALID_STAGED_ROW_ERROR
      : timedOut
        ? MATCH_TIMED_OUT_ERROR
        : null;
    if (
      !next ||
      (next.action === item.action &&
        nextWarning === item.warning &&
        nextErrorCode === item.errorCode)
    ) {
      continue;
    }
    const key = JSON.stringify([next.action, nextWarning, nextErrorCode]);
    const data = { action: next.action, warning: nextWarning, errorCode: nextErrorCode };
    const group = writes.get(key);
    if (group) group.ids.push(item.id);
    else writes.set(key, { data, ids: [item.id] });
  }

  // One transaction, so a failed write still leaves every row as it was.
  if (writes.size > 0) {
    await prisma.$transaction(
      [...writes.values()].map(({ data, ids }) =>
        prisma.importItem.updateMany({ where: { jobId, id: { in: ids } }, data }),
      ),
      { timeout: RECONCILE_TX_TIMEOUT_MS },
    );
  }
  return getImportJobView(userId, jobId);
}

function movieAsSearchItem(movie: TmdbMovieDetails): TmdbSearchItem {
  return {
    id: movie.id,
    media_type: "movie",
    title: movie.title,
    original_title: movie.original_title,
    release_date: movie.release_date,
    poster_path: movie.poster_path,
    original_language: movie.original_language,
  };
}

function tvAsSearchItem(tv: TmdbTvDetails): TmdbSearchItem {
  return {
    id: tv.id,
    media_type: "tv",
    name: tv.name,
    original_name: tv.original_name,
    first_air_date: tv.first_air_date,
    poster_path: tv.poster_path,
    original_language: tv.original_language,
  };
}

/**
 * Resolve a row through the exact identifier its file carried, if any. A TMDB,
 * IMDb or TVDB id names one title outright, so honouring it skips the fuzzy
 * name search entirely, the single biggest accuracy win on a large export,
 * where "Drishyam" or "The Office" otherwise resolves by popularity. Never
 * throws: a dead id or a TMDB failure just returns null so the caller falls
 * back to searching by name. Every lookup takes the staging `signal`, so none
 * runs on to its own deadline past the staging budget. The score is 1 for a
 * certain match, lower when review should check it.
 */
export async function resolveByExactId(
  parsed: ParsedTitle,
  signal: AbortSignal,
): Promise<{ match: TmdbSearchItem; score: number } | null> {
  const tmdbId = parsed.tmdbId ?? null;
  if (tmdbId !== null) {
    // The Type column is a hint, not a guarantee, and a TMDB id means nothing
    // without its kind — so an id that doesn't exist as the declared kind is
    // tried as the other one before we give up on it.
    const kinds =
      parsed.mediaType === "tv" ? (["tv", "movie"] as const) : (["movie", "tv"] as const);
    for (const kind of kinds) {
      try {
        const match =
          kind === "movie"
            ? movieAsSearchItem(await getMovie(tmdbId, { signal }))
            : tvAsSearchItem(await getTv(tmdbId, { signal }));
        return { match, score: 1 };
      } catch {
        // Wrong kind or unknown id — try the other kind, then the name search.
      }
    }
  }
  if (parsed.imdbId) {
    try {
      const found = await findByImdbId(parsed.imdbId, { signal });
      // An episode's id finds no title, so the row falls back to the name
      // search rather than importing the episode's status as its show's.
      const title = found.find((item) => item.media_type === parsed.mediaType) ?? found[0];
      if (title) return { match: title, score: 1 };
    } catch {
      // Fall through to the TVDB id, then the name search.
    }
  }
  if (parsed.tvdbId) {
    try {
      const [show] = await findTvByTvdbId(parsed.tvdbId, { signal });
      // A file's TVDB column can hold episode ids, which TVDB numbers apart
      // from series, so a collision can name an unrelated show. Trust the id
      // only when the names agree; otherwise leave it for review to check.
      if (show) {
        const namesAgree = pickBest([show], parsed.name, null) !== null;
        return { match: show, score: namesAgree ? 1 : scoreImportMatch(parsed, show) };
      }
    } catch {
      // Fall through to the name search.
    }
  }
  return null;
}

export async function stageParsedImport(input: {
  userId: string;
  jobId: string;
  parsed: ParsedTitle[];
  summary: Record<string, unknown>;
  /** Epoch ms at which matching must stop. See IMPORT_STAGING_BUDGET_MS. */
  deadlineAt?: number;
}): Promise<StagedImportJobView> {
  const deadlineAt = input.deadlineAt ?? Date.now() + IMPORT_STAGING_BUDGET_MS;
  const expired = () => Date.now() >= deadlineAt;
  // Abort searches still in flight when the budget runs out, rather than paying
  // each one's own multi-attempt deadline past ours.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadlineAt - Date.now()));

  let matched: {
    raw: ParsedTitle;
    parsed: ParsedTitle;
    proposed: ProposedImportMatch | null;
    score: number | null;
    invalid: boolean;
    timedOut: boolean;
  }[];
  try {
    matched = await mapLimit(
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
            timedOut: false,
          };
        }

        const validParsed = validated.data;
        const unmatched = (timedOut: boolean) => ({
          raw: parsed,
          parsed: validParsed,
          proposed: null,
          score: null,
          invalid: false,
          timedOut,
        });
        if (expired()) return unmatched(true);

        try {
          const exact = await resolveByExactId(validParsed, controller.signal);
          if (exact) {
            return {
              raw: parsed,
              // An exact id also settles the kind, so correct the row when the
              // file's Type column disagreed with the identifier it supplied.
              parsed: {
                ...validParsed,
                mediaType: exact.match.media_type === "tv" ? ("tv" as const) : ("movie" as const),
              },
              proposed: proposedMatchFromTmdb(exact.match),
              score: exact.score,
              invalid: false,
              timedOut: false,
            };
          }
          const year = parsedYear(validParsed);
          const results = await searchByType(validParsed.mediaType, validParsed.name, 1, {
            year,
            signal: controller.signal,
          });
          const best = pickBest(results, validParsed.name, year);
          return {
            raw: parsed,
            parsed: validParsed,
            proposed: best ? proposedMatchFromTmdb(best) : null,
            score: best ? scoreImportMatch(validParsed, best) : null,
            invalid: false,
            timedOut: false,
          };
        } catch (error) {
          if (expired()) return unmatched(true);
          console.error(`Staged import match failed for ${validParsed.name}:`, error);
          return unmatched(false);
        }
      },
    );
  } finally {
    clearTimeout(timer);
  }

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
      errorCode: item.invalid
        ? INVALID_STAGED_ROW_ERROR
        : item.timedOut
          ? MATCH_TIMED_OUT_ERROR
          : null,
      warning: item.invalid
        ? INVALID_STAGED_ROW_WARNING
        : item.proposed
          ? null
          : item.timedOut
            ? MATCH_TIMED_OUT_WARNING
            : NO_MATCH_WARNING,
    })),
  });
  const timedOutRows = matched.filter((item) => item.timedOut).length;
  await prisma.importJob.update({
    where: { id: input.jobId },
    data: {
      status: "READY_FOR_REVIEW",
      summary: asJson({ ...input.summary, timedOutRows }),
    },
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
    select: {
      id: true,
      rowNumber: true,
      normalized: true,
      matchScore: true,
      titleId: true,
      attempts: true,
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

/**
 * Exclude a set of reviewed rows in one pass. Reviewing 250 rows one checkbox at
 * a time cost a round trip — and a full reconcile — per row; this settles a
 * whole selection with a single write. Rows that already produced a title are
 * left alone: they are committed history, not proposals.
 */
export async function excludeImportItems(input: {
  userId: string;
  jobId: string;
  itemIds: string[];
}): Promise<StagedImportJobView | null> {
  const job = await prisma.importJob.findFirst({
    where: {
      id: input.jobId,
      userId: input.userId,
      status: { in: ["READY_FOR_REVIEW", "PARTIAL"] },
    },
    select: { id: true },
  });
  if (!job) return null;

  await prisma.importItem.updateMany({
    where: { id: { in: input.itemIds }, jobId: input.jobId, titleId: null },
    data: { action: "SKIP", errorCode: null, warning: null },
  });
  await prisma.importJob.updateMany({
    where: { id: input.jobId, userId: input.userId, status: { in: ["PARTIAL", "FAILED"] } },
    data: { status: "READY_FOR_REVIEW", committedAt: null },
  });
  return reconcileImportActions(input.userId, input.jobId);
}

/**
 * The personal fields a staged row can seat on a title it just created. A rating
 * and a watch date are facts the owner supplied in the file, so they are written
 * where the file provides them; a sheet with neither leaves both untouched. Still
 * no WatchEvent: a date says when a title was finished, not how many times it was
 * watched, and inventing history would move the recommendation engine's recency
 * signal and the stats activity views.
 */
function personalFieldsFor(parsed: ParsedTitle): {
  rating?: number;
  watchedAt?: Date;
} {
  const watchedAt = parsed.watchedAt ? new Date(`${parsed.watchedAt}T00:00:00.000Z`) : null;
  return {
    ...(parsed.rating != null ? { rating: parsed.rating } : {}),
    ...(watchedAt && !Number.isNaN(watchedAt.getTime()) ? { watchedAt } : {}),
  };
}

/**
 * Seat a freshly created import title's personal status, source, and any rating
 * or watch date the sheet carried. Movies (and any non-watched import) take the
 * plain single-row write. A TV title imported as WATCHED must be episode-backed:
 * addFromTmdb creates every episode unwatched, so writing status = WATCHED alone
 * would leave a 0/N "watched" show that demotes to WATCHING the first time the
 * owner ticks an episode (recomputeProgress recounts from the rows). Mark the
 * aired episodes watched — with no date, since a sheet dates the show, not each
 * episode — sync watchedEpisodes to the real count, then derive the status from
 * those rows. Runs under a Title-FOR-UPDATE-first lock (the same order every
 * write in this app takes) so a concurrent episode toggle's recompute can't
 * interleave. Mirrors run-import's markWatched/deriveStatus contract while
 * deliberately leaving WatchEvents absent.
 */
async function applyStagedStatus(
  userId: string,
  titleId: string,
  dbMediaType: "MOVIE" | "TV",
  parsed: ParsedTitle,
): Promise<void> {
  const status = importStatusForParsed(parsed);
  const personal = personalFieldsFor(parsed);
  if (dbMediaType !== "TV" || status !== "WATCHED") {
    await prisma.title.updateMany({
      where: { id: titleId, userId },
      data: { status, source: parsed.source, ...personal },
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    if (!rows[0]) return; // title removed concurrently
    // Mark every AIRED episode watched (no date — a sheet dates the show as a
    // whole, never an episode). This used to mark every episode, which pre-ticked
    // next week's episode of a still-airing show: a pre-marked episode is already
    // `watched` when it airs, so its "New" badge never fires and the episode the
    // owner was waiting for arrives looking like something already seen. A null
    // airDate means TMDB doesn't know, which counts as aired — the same rule the
    // episode tracker's bulk marks use. Episodes already watched keep their
    // date: a seed retry can find the owner's own ticks, and withdrawn rows are
    // always watched (P7X-2).
    const now = new Date();
    await tx.episode.updateMany({
      where: {
        season: { titleId },
        watched: false,
        OR: [{ airDate: null }, { airDate: { lte: now } }],
      },
      data: { watched: true, watchedAt: null },
    });
    // Count what is actually watched rather than assuming the sheet's "watched"
    // covers the whole run: with unaired episodes left alone the total is no
    // longer the watched count, and a denormalized cache that disagrees with the
    // rows is corrected — visibly, under the owner — by the next recompute.
    // Withdrawn episodes stay watched but are out of the progress counts, as in
    // recomputeProgress; counting them could exceed totalEpisodes (PR-11).
    const [total, watched] = await Promise.all([
      tx.episode.count({ where: { season: { titleId }, ...ACTIVE_EPISODE_FILTER } }),
      tx.episode.count({
        where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
      }),
    ]);
    await tx.title.update({
      where: { id: titleId },
      data: {
        source: parsed.source,
        ...personal,
        watchedEpisodes: watched,
        // Episode-backed status, derived from the rows the way recomputeProgress
        // will derive it: caught up on an airing show is WATCHING, not WATCHED.
        // Writing that reconciled value — not the sheet's WATCHED at 0/N, and not
        // WATCHED over a run with episodes still to come — is what stops the
        // first episode toggle's recompute from changing the status underneath
        // the owner. A show with no episode rows at all keeps the sheet's word:
        // nothing will ever recount it.
        status:
          total === 0
            ? status
            : watched >= total
              ? "WATCHED"
              : watched > 0
                ? "WATCHING"
                : "WATCHLIST",
      },
    });
  });
}

/**
 * Apply the conservative existing-title policy under a fresh Title lock after
 * metadata refresh/Trash restore. Rereading here means a rating or status saved
 * concurrently with the refresh wins over the spreadsheet. This is deliberately
 * separate from the new-title path above: existing notes, favorite, tags,
 * source, episode progress, and every non-WATCHLIST status stay authoritative.
 */
async function mergeExistingStagedFacts(
  userId: string,
  titleId: string,
  dbMediaType: "MOVIE" | "TV",
  parsed: ParsedTitle,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        status: ExistingLibraryStatus;
        rating: number | null;
        watchedAt: Date | null;
      }>
    >`
      SELECT id, status, rating, "watchedAt"
      FROM "Title"
      WHERE id = ${titleId} AND "userId" = ${userId}
      FOR UPDATE`;
    const current = rows[0];
    if (!current) return; // title removed concurrently

    const patch = planExistingImportMerge(current, parsed);
    const personal = {
      ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
      ...(patch.watchedAt !== undefined
        ? { watchedAt: new Date(`${patch.watchedAt}T00:00:00.000Z`) }
        : {}),
    };

    if (dbMediaType !== "TV" || patch.status !== "WATCHED") {
      if (Object.keys(patch).length === 0) return;
      await tx.title.update({
        where: { id: titleId },
        data: {
          ...personal,
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        },
      });
      return;
    }

    // A WATCHED TV import is episode-backed just like a new staged title. Only
    // aired/unknown-date episodes are advanced; future episodes remain unwatched.
    const now = new Date();
    await tx.episode.updateMany({
      where: {
        season: { titleId },
        watched: false,
        OR: [{ airDate: null }, { airDate: { lte: now } }],
      },
      data: { watched: true, watchedAt: null },
    });
    // Active episodes only, as in applyStagedStatus above (PR-11).
    const [total, watched] = await Promise.all([
      tx.episode.count({ where: { season: { titleId }, ...ACTIVE_EPISODE_FILTER } }),
      tx.episode.count({
        where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
      }),
    ]);
    await tx.title.update({
      where: { id: titleId },
      data: {
        ...personal,
        watchedEpisodes: watched,
        status:
          total === 0
            ? "WATCHED"
            : watched >= total
              ? "WATCHED"
              : watched > 0
                ? "WATCHING"
                : "WATCHLIST",
      },
    });
  });
}

/**
 * The fields a commit wrote to one row. The caller folds this back into the job
 * it already holds, so settling the batch's outcome doesn't need to re-read
 * every row of a job it just walked. Null means the row was left untouched.
 */
type CommittedItemPatch = {
  titleId?: string | null;
  action?: ImportItemAction;
  warning?: string | null;
  errorCode?: string | null;
  attempts?: number;
} | null;

async function commitOneImportItem(
  userId: string,
  itemId: string,
): Promise<CommittedItemPatch> {
  const item = await prisma.importItem.findFirst({
    where: { id: itemId, job: { userId } },
    select: { id: true, normalized: true, action: true, titleId: true, attempts: true },
  });
  if (!item || item.action === "SKIP" || item.action === "CONFLICT") {
    return null;
  }
  // A row that already checkpointed a new title never needs another TMDB
  // create/rematch. Only a failed seed retry is actionable; a CREATE/UPDATE
  // row with a titleId is already terminal audit history.
  if (item.titleId && item.action !== "FAILED") return null;
  if (item.action === "FAILED" && item.attempts >= IMPORT_MAX_ATTEMPTS) return null;

  const normalizedResult = stagedNormalizedSchema.safeParse(item.normalized);
  if (!normalizedResult.success) {
    const patch = {
      action: "CONFLICT" as const,
      errorCode: INVALID_STAGED_ROW_ERROR,
      warning: INVALID_STAGED_ROW_WARNING,
    };
    await prisma.importItem.update({ where: { id: item.id }, data: patch });
    return patch;
  }
  const normalized = normalizedResult.data;
  const proposed = normalized.proposed;
  if (!proposed) {
    const patch = { action: "CONFLICT" as const, warning: NO_MATCH_WARNING };
    await prisma.importItem.update({ where: { id: item.id }, data: patch });
    return patch;
  }

  const mediaType = proposed.mediaType;
  const dbMediaType = mediaType === "tv" ? "TV" : "MOVIE";
  if (item.titleId) {
    try {
      await applyStagedStatus(userId, item.titleId, dbMediaType, normalized.parsed);
      const patch = {
        titleId: item.titleId,
        action: "CREATE" as const,
        warning: null,
        errorCode: null,
        attempts: item.attempts + 1,
      };
      await prisma.importItem.update({
        where: { id: item.id },
        data: {
          action: patch.action,
          warning: patch.warning,
          errorCode: patch.errorCode,
          attempts: { increment: 1 },
        },
      });
      return patch;
    } catch (error) {
      console.error(`Staged import seed retry failed for ${normalized.parsed.name}:`, error);
      const patch = {
        titleId: item.titleId,
        action: "FAILED" as const,
        errorCode: "IMPORT_WRITE_FAILED",
        warning: CREATED_WITHOUT_PERSONAL_FIELDS_WARNING,
        attempts: item.attempts + 1,
      };
      await prisma.importItem.update({
        where: { id: item.id },
        data: {
          action: patch.action,
          errorCode: patch.errorCode,
          warning: patch.warning,
          attempts: { increment: 1 },
        },
      });
      return patch;
    }
  }
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

  let createdTitleId: string | undefined;
  let createWarning: string | null = null;
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
        // addFromTmdb commits independently. Checkpoint its id before the
        // personal-field seed so a dropped connection or killed request cannot
        // leave an invisible library title behind a retryable CREATE row.
        createdTitleId = titleId;
        createWarning = warning;
        await prisma.importItem.update({
          where: { id: item.id },
          data: {
            titleId,
            action: "CREATE",
            warning: CREATED_WITHOUT_PERSONAL_FIELDS_WARNING,
            errorCode: null,
          },
        });
      }
    }

    if (action === "UPDATE") {
      await mergeExistingStagedFacts(userId, titleId, dbMediaType, normalized.parsed);
    } else {
      await applyStagedStatus(userId, titleId, dbMediaType, normalized.parsed);
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
    return { titleId, action, warning, errorCode: null, attempts: item.attempts + 1 };
  } catch (error) {
    console.error(`Staged import commit failed for ${normalized.parsed.name}:`, error);
    if (createdTitleId) {
      const warning = [createWarning, CREATED_WITHOUT_PERSONAL_FIELDS_WARNING]
        .filter((value): value is string => Boolean(value))
        .join(" ");
      const patch = {
        titleId: createdTitleId,
        action: "CREATE" as const,
        errorCode: null,
        warning,
        attempts: item.attempts + 1,
      };
      await prisma.importItem.update({
        where: { id: item.id },
        data: {
          titleId: patch.titleId,
          action: patch.action,
          errorCode: patch.errorCode,
          warning: patch.warning,
          attempts: { increment: 1 },
        },
      });
      return patch;
    }
    const patch = {
      action: "FAILED" as const,
      errorCode: "IMPORT_WRITE_FAILED",
      warning: "Celluloid couldn't save this title. Retry after checking the match.",
    };
    await prisma.importItem.update({
      where: { id: item.id },
      data: { ...patch, attempts: { increment: 1 } },
    });
    return { ...patch, attempts: item.attempts + 1 };
  }
}

/**
 * Settle the job's status and counts from the rows the caller is already
 * holding. It takes the loaded job rather than a job id because the commit path
 * walked every row of it moments ago — re-reading the whole job (and then
 * re-reading it a third time to serialize a view) cost a 250-row import around
 * 150 full-job fetches, all to recount rows it had just written.
 *
 * The final write is conditional on the job still being the COMMITTING one this
 * batch claimed, so a cancel that lands mid-batch is reported rather than
 * overwritten with a derived outcome.
 */
async function refreshJobOutcome(userId: string, job: NonNullable<JobWithItems>) {
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
  const summary = { ...(summaryRecord(job.summary) ?? {}), ...counts };
  const committedAt = status === "COMPLETED" || status === "PARTIAL" ? new Date() : null;
  const settled = await prisma.importJob.updateMany({
    where: { id: job.id, userId, status: "COMMITTING" },
    data: { status, summary: asJson(summary), committedAt },
  });
  if (settled.count === 0) {
    const current = await findImportJob(userId, job.id);
    return current ? serializeImportJob(current) : null;
  }
  return {
    ...serializeImportJob(job),
    status,
    summary,
    committedAt: committedAt?.toISOString() ?? null,
  };
}

export async function commitImportJobChunk(
  userId: string,
  jobId: string,
  deadlineAt = Date.now() + IMPORT_COMMIT_BUDGET_MS,
): Promise<StagedImportJobView | null> {
  // Claim the job conditionally. Reading the status and then writing COMMITTING
  // unconditionally meant a cancel landing between the two was erased and the
  // whole import committed anyway — after review had told the owner uncommitted
  // rows would be abandoned. Two tabs, or one stale tab, was enough.
  const claimed = await prisma.importJob.updateMany({
    where: {
      id: jobId,
      userId,
      status: { in: ["READY_FOR_REVIEW", "COMMITTING", "PARTIAL"] },
    },
    data: { status: "COMMITTING" },
  });
  const job = await findImportJob(userId, jobId);
  if (!job) return null;
  // Not ours to commit: report the job's real state so the UI shows the
  // cancellation (or completion) instead of a commit that never happened.
  if (claimed.count === 0) return serializeImportJob(job);

  const candidates = job.items
    .filter(
      (item) =>
        (item.action === "CREATE" ||
          item.action === "UPDATE" ||
          (item.action === "FAILED" && item.attempts < IMPORT_MAX_ATTEMPTS)) &&
        (!item.titleId || item.action === "FAILED"),
    )
    .slice(0, IMPORT_COMMIT_BATCH_SIZE);
  for (const item of candidates) {
    // Each item may make several cold TMDB requests before its bounded DB
    // write. Once the request budget is gone, starting another is what lets the
    // platform kill us mid-item; stopping here leaves that row untouched and
    // therefore safely resumable by the next commit request.
    if (Date.now() >= deadlineAt) break;
    const state = await prisma.importJob.findFirst({
      where: { id: job.id, userId },
      select: { status: true },
    });
    if (!state || state.status === "CANCELLED") break;
    const patch = await commitOneImportItem(userId, item.id);
    // Fold the write back into the loaded row so the outcome below is derived
    // from what this batch actually did, without re-reading the job.
    if (patch) Object.assign(item, patch);
  }
  return refreshJobOutcome(userId, job);
}

export async function cancelImportJob(userId: string, jobId: string): Promise<boolean> {
  const result = await prisma.importJob.updateMany({
    where: { id: jobId, userId, status: { notIn: ["COMPLETED", "CANCELLED"] } },
    data: { status: "CANCELLED" },
  });
  return result.count > 0;
}
