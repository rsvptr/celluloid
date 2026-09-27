"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
// Prisma is imported as a value (not `type`) alongside the enums: we reference
// Prisma.PrismaClientKnownRequestError at runtime to catch the addFromTmdb
// unique-constraint race. Its namespace also provides the types used below.
import {
  MediaType,
  MetadataSyncState,
  WatchStatus,
  WatchEventKind,
  WatchEventSource,
  Prisma,
} from "@/generated/prisma/client";
import { dayStartInZone } from "@/lib/data";
import {
  getMovie,
  getSeasons,
  getTv,
  MAX_APPENDED_SEASONS,
  type TmdbSeasonDetails,
} from "@/lib/tmdb";
import { mapLimit } from "@/lib/async";
import { isTagColor } from "@/lib/tag-colors";
import { tagNameFilter } from "@/lib/tag-name";
import {
  ACTIVE_EPISODE_FILTER,
  chunks,
  deriveNextEpisodeAirDate,
  discoveredAtForNewEpisode,
  planEpisodeEventRelinks,
  preservesEpisodeHistory,
  RELINK_BATCH_SIZE,
  tvRuntime,
  WITHDRAWN_EPISODE_NUMBER_OFFSET,
  type EpisodeEventCoordinate,
} from "@/lib/rematch-history";
import { z } from "zod";

// --- Runtime validation (SEC-04) -------------------------------------------
// Every exported function here is a server action: a public HTTP endpoint that
// can be invoked with arbitrary arguments. TypeScript types are erased at
// runtime and validate nothing, so each action safeParses its arguments before
// any database or network work (immediately after the session check, which is
// left where it is). Expected failures use the `{ error }` result contract:
// Next.js redacts thrown Server Action messages in production, while these
// messages are safe and meant to help the owner recover.

/**
 * Hard ceiling on ids processed per bulk call, after dedup. This is a
 * resource/DoS guard, not a UX limit — the owner legitimately runs bulk ops
 * over more than a couple hundred titles, so exceeding it is a rejected
 * request (see dedupeIds' callers), never a silent truncation that would
 * quietly drop titles the user selected and expected to be affected.
 */
const MAX_BULK_IDS = 1000;

/** Error message returned when a deduped id list exceeds MAX_BULK_IDS. */
const TOO_MANY_IDS_MESSAGE = `Too many titles selected (max ${MAX_BULK_IDS}).`;
const SIGNED_OUT_MESSAGE = "You're signed out. Sign in and try again.";

/** Our own cuid primary keys: non-empty, bounded to reject oversized payloads. */
const idSchema = z.string().min(1).max(64);
/**
 * TMDB ids are positive integers. The upper bound is the Postgres int4 max, so
 * an out-of-range id is a clean validation error instead of a DB overflow 500.
 */
const tmdbIdSchema = z.number().int().positive().max(2_147_483_647);
/** Wire form of media type accepted by add/rematch (not the Prisma enum). */
const mediaTypeSchema = z.enum(["movie", "tv"]);
/** Personal watch status, validated against the real Prisma enum. */
const watchStatusSchema = z.nativeEnum(WatchStatus);

/**
 * A date string toDate() can parse (calendar date or full ISO). Mirrors toDate's
 * own parse so a value that validates here can't later silently collapse to null.
 */
const dateStringSchema = z
  .string()
  .max(40)
  .refine((s) => {
    const d = new Date(s.length <= 10 ? `${s}T00:00:00.000Z` : s);
    return Number.isFinite(d.getTime());
  }, "Invalid date");

const updateTitleArgsSchema = z.object({
  id: idSchema,
  data: z.object({
    status: watchStatusSchema.optional(),
    // Any finite number is accepted here; the 0.5-10 half-step domain (CP-09) is
    // applied after parsing. z.number() already rejects NaN and Infinity.
    rating: z.number().nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
    favorite: z.boolean().optional(),
    watchedAt: dateStringSchema.nullable().optional(),
  }),
});

// logWatch: record a viewing (occurredAt) with an optional short note. The note
// is generously bounded here as an abuse guard, then trimmed and capped to 500
// chars before storage — the same bound-then-slice shape updateTitle uses for
// freehand notes.
const logWatchSchema = z.object({
  titleId: idSchema,
  occurredAt: dateStringSchema,
  note: z.string().max(2000).nullable().optional(),
});

const idArgSchema = z.object({ id: idSchema });
const watchEventIdSchema = z.object({ eventId: idSchema });
const watchEventEditSchema = z.object({
  eventId: idSchema,
  occurredAt: dateStringSchema,
  note: z.string().max(2000).nullable().optional(),
});
const undoWatchedTransitionSchema = z.object({
  titleId: idSchema,
  occurredAt: dateStringSchema,
  restoreWatchedAt: dateStringSchema.nullable(),
  restoreStatus: watchStatusSchema,
});
const episodeToggleSchema = z.object({ episodeId: idSchema, watched: z.boolean() });
const seasonToggleSchema = z.object({ seasonId: idSchema, watched: z.boolean() });
const allEpisodesSchema = z.object({ titleId: idSchema, watched: z.boolean() });
const episodesThroughSchema = z.object({ episodeId: idSchema });
const addFromTmdbSchema = z.object({ tmdbId: tmdbIdSchema, mediaType: mediaTypeSchema });
const rematchSchema = z.object({
  titleId: idSchema,
  tmdbId: tmdbIdSchema,
  mediaType: mediaTypeSchema,
});
const bulkStatusSchema = z.object({ ids: z.array(idSchema), status: watchStatusSchema });
const bulkFavoriteSchema = z.object({ ids: z.array(idSchema), favorite: z.boolean() });
// Freehand tag text is bounded here (abuse guard); normTagName then trims,
// collapses whitespace and caps at 64 before the value is stored.
const bulkTagSchema = z.object({ ids: z.array(idSchema), tagName: z.string().max(200) });
const bulkIdsSchema = z.object({ ids: z.array(idSchema) });
const createTagSchema = z.object({
  name: z.string().max(200),
  color: z.string().max(64).nullable().optional(),
});
const toggleTitleTagSchema = z.object({
  titleId: idSchema,
  tagId: idSchema,
  on: z.boolean(),
});
const tagIdArgSchema = z.object({ tagId: idSchema });
const renameTagSchema = z.object({ tagId: idSchema, name: z.string().max(200) });
// Colours are chosen from a fixed palette (see tag-colors.ts), never freehand,
// so the stored value is validated against that list rather than bounded as text.
const tagColorSchema = z.object({
  tagId: idSchema,
  color: z.string().refine(isTagColor).nullable(),
});

/** Dedupe an id list. Does not truncate — callers must reject oversized lists
 * outright (via bulkLimitError) rather than silently drop ids. */
function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Returns an error when a deduped id list exceeds MAX_BULK_IDS. Call this
 * after dedupeIds and before any DB work so an oversized selection does
 * nothing (no partial apply) instead of silently processing only the first slice.
 */
function bulkLimitError(ids: string[]): string | null {
  return ids.length > MAX_BULK_IDS ? TOO_MANY_IDS_MESSAGE : null;
}

async function getUserId(): Promise<string | null> {
  const session = await getSession();
  return session?.user?.id ?? null;
}

/**
 * TMDB release and air dates. These are calendar metadata with no owner and no
 * zone — a film released on a date, everywhere — so they stay UTC midnight.
 * Viewing dates the owner submits go through toViewingDate instead.
 */
function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00.000Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A viewing date submitted by the owner. A bare "YYYY-MM-DD" is the day the
 * date input was set to, which the owner picked in their own calendar, so it
 * resolves to that day's start in the account's zone; reading it as UTC midnight
 * filed every viewing west of UTC under the previous activity day (AUD-05). A
 * longer value is already a full instant (the history editor sends the stored
 * one back when only the note changed) and passes through untouched, so an
 * unedited day cannot drift. The account row is read only when there is
 * actually a calendar day to place.
 */
async function toViewingDate(
  userId: string,
  iso: string | null | undefined,
): Promise<Date | null> {
  if (!iso) return null;
  if (iso.length > 10) {
    const instant = new Date(iso);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeZone: true },
  });
  const start = dayStartInZone(iso, user?.timeZone || "UTC");
  return Number.isNaN(start.getTime()) ? null : start;
}

/** Collapse whitespace and bound tag names so freehand input stays sane. */
function normTagName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 64);
}

/**
 * Tag identity is case-insensitive: the DB has a unique index on
 * (userId, lower(name)) in addition to the case-sensitive userId_name unique,
 * so a case-sensitive lookup can miss an existing "Horror" when asked for
 * "horror" and then trip the case-insensitive index's unique violation
 * (P2002) on create. Look up insensitively and reuse the existing row's
 * casing; only create when no case-variant exists. A concurrent create of the
 * same case-variant can still race between the lookup and the create, so a
 * P2002 there re-looks-up (insensitively) instead of surfacing the raw error.
 */
async function findOrCreateTag(
  userId: string,
  name: string,
  color: string | null = null,
): Promise<{ id: string; name: string }> {
  const existing = await prisma.tag.findFirst({
    where: { userId, name: tagNameFilter(name) },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  try {
    return await prisma.tag.create({
      data: { userId, name, color },
      select: { id: true, name: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const race = await prisma.tag.findFirst({
        where: { userId, name: tagNameFilter(name) },
        select: { id: true, name: true },
      });
      if (race) return race;
    }
    throw err;
  }
}

/**
 * Expires the library-wide pages. After any revalidatePath, whatever the path,
 * Next also re-renders the current page into the calling action's response
 * (and the client refetches it when a response carries none), so a title page
 * edit still comes back rendered.
 *
 * The title's own path is left out on purpose (VE-03). Title pages are
 * dynamic, so their path tag only keys the TMDB Data Cache entries fetched
 * while rendering them; expiring it made every edit, notes autosaves included,
 * refetch TMDB. rematchTitle expires it itself. This stays on revalidatePath:
 * refresh() throws in route handlers, and the import commit route runs
 * addFromTmdb and rematchTitle.
 */
function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/stats");
  revalidatePath("/export");
}

/**
 * Prisma filter for "this episode has actually aired". A null airDate means TMDB
 * doesn't know (common for older and regional titles), which we treat as aired
 * rather than blocking the user from ticking it.
 *
 * The bulk episode marks use this so that "mark season" / "mark show" on an
 * ONGOING series can't silently tick episodes that haven't aired yet. Doing so
 * was quietly destructive: a pre-marked episode is already `watched` by the time
 * it airs, so its "New" badge never fires and the episode you were waiting for
 * shows up as something you'd already seen. A single deliberate tick on one
 * episode is left unguarded — the owner may have seen a preview.
 */
function airedEpisodeFilter(now: Date) {
  return {
    ...ACTIVE_EPISODE_FILTER,
    OR: [{ airDate: null }, { airDate: { lte: now } }],
  };
}

type LockedProgressTitle = {
  userId: string;
  status: WatchStatus;
  watchedAt: Date | null;
};

/** The status that `watched` of `total` episodes leaves in place of `status`. */
function progressStatus(status: WatchStatus, watched: number, total: number) {
  // Don't override deliberate ON_HOLD / DROPPED choices. At zero progress,
  // preserve every deliberate state except WATCHED: removing the final tick
  // must stop claiming the show is complete, but WATCHING stays WATCHING.
  if (status === WatchStatus.ON_HOLD || status === WatchStatus.DROPPED) return status;
  if (watched === 0) return status === WatchStatus.WATCHED ? WatchStatus.WATCHLIST : status;
  if (total > 0 && watched >= total) return WatchStatus.WATCHED;
  return WatchStatus.WATCHING;
}

/**
 * Recompute denormalized episode progress while the caller holds the Title lock.
 * `restoreStatus` is the status an undo would put back; it is used only when
 * progressStatus would leave it unchanged, otherwise the usual recount applies.
 */
async function recomputeProgress(
  tx: Prisma.TransactionClient,
  titleId: string,
  title: LockedProgressTitle,
  restoreStatus?: WatchStatus,
) {
  const total = await tx.episode.count({
    where: { season: { titleId }, ...ACTIVE_EPISODE_FILTER },
  });
  const watched = await tx.episode.count({
    where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
  });

  const status =
    restoreStatus !== undefined &&
    progressStatus(restoreStatus, watched, total) === restoreStatus
      ? restoreStatus
      : progressStatus(title.status, watched, total);

  const data: { watchedEpisodes: number; status: WatchStatus; watchedAt?: Date } = {
    watchedEpisodes: watched,
    status,
  };
  const entersWatched =
    status === WatchStatus.WATCHED && title.status !== WatchStatus.WATCHED;
  // The tracker models progress, not repeat viewings. A correction gesture
  // can temporarily move WATCHED -> WATCHING -> WATCHED; if completion
  // history already survives, that is not a new watch and must not restamp
  // the cache. Genuine repeats go through logWatch as REWATCH events.
  const priorCompletion = entersWatched
    ? await tx.watchEvent.findFirst({
        where: {
          userId: title.userId,
          titleId,
          kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
        },
        select: { id: true },
      })
    : null;
  const logsCompletion = entersWatched && priorCompletion == null;
  const completedAt = logsCompletion ? new Date() : null;
  if (completedAt) data.watchedAt = completedAt;

  await tx.title.update({ where: { id: titleId }, data });
  if (completedAt) {
    await tx.watchEvent.create({
      data: {
        userId: title.userId,
        titleId,
        kind: WatchEventKind.TITLE_COMPLETED,
        occurredAt: completedAt,
        source: WatchEventSource.BULK,
      },
    });
  }
}

// --- Title field updates ---------------------------------------------------

export async function updateTitle(
  id: string,
  data: {
    status?: WatchStatus;
    rating?: number | null;
    notes?: string | null;
    favorite?: boolean;
    watchedAt?: string | null;
  },
) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  // Server actions are network-callable with arbitrary args. Validate the whole
  // payload up front (unknown status, non-finite/oversized rating, oversized
  // notes, non-date watchedAt) so bad input is a clear error, not a Prisma 500.
  const parsed = updateTitleArgsSchema.safeParse({ id, data });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const input = parsed.data.data;

  const now = new Date();

  // CP-09: personal rating is null (cleared) or 0.5-10 in half-star steps. Any
  // value below the 0.5 minimum (including 0 and negatives) clears the rating —
  // mirroring RatingStars' own `next < 0.5 -> null` rule — instead of storing a 0
  // that would violate the documented 0.5-10 domain and skew stats averages.
  // Valid values snap to the half-steps the UI uses and clamp the top at 10.
  // undefined leaves the rating untouched (non-finite input was rejected above).
  let ratingUpdate: { rating?: number | null } = {};
  if (input.rating !== undefined) {
    ratingUpdate = {
      rating:
        input.rating === null || input.rating < 0.5
          ? null
          : Math.min(10, Math.round(input.rating * 2) / 2),
    };
  }

  // Resolved before the transaction: placing a calendar day needs the account's
  // zone, and that read has no business running inside the title lock.
  const submittedWatchedAt =
    input.watchedAt === undefined
      ? undefined
      : await toViewingDate(userId, input.watchedAt);

  const found = await prisma.$transaction(async (tx) => {
    // The locked row is both the ownership check and the transition source of
    // truth. Computing from an earlier findFirst allowed two concurrent
    // "WATCHED" requests to both observe WATCHING, then each append a completion.
    const rows = await tx.$queryRaw<
      {
        status: WatchStatus;
        watchedAt: Date | null;
        totalEpisodes: number | null;
        mediaType: MediaType;
      }[]
    >`SELECT status, "watchedAt", "totalEpisodes", "mediaType" FROM "Title"
      WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return false;

    // A genuine transition into WATCHED with no explicit caller date advances
    // the completion time. This must be derived after the lock: the row may have
    // become WATCHED while this request was waiting.
    const autoWatchedAt =
      input.watchedAt === undefined &&
      input.status === WatchStatus.WATCHED &&
      title.status !== WatchStatus.WATCHED &&
      title.watchedAt === null
        ? now
        : undefined;
    const nextStatus = input.status ?? title.status;
    const newWatchedAt: Date | null =
      input.watchedAt !== undefined
        ? (submittedWatchedAt ?? null)
        : (autoWatchedAt ?? title.watchedAt);
    const logsCompletion =
      nextStatus === WatchStatus.WATCHED && title.status !== WatchStatus.WATCHED;
    const completionAt = logsCompletion ? (newWatchedAt ?? now) : null;
    // A TV status transition is a reversible bulk operation: its completion and
    // episode events use one source + instant as the transition identity.
    const reversibleTvCompletion = logsCompletion && title.mediaType === MediaType.TV;
    const redatesCompletion =
      !logsCompletion &&
      input.watchedAt !== undefined &&
      nextStatus === WatchStatus.WATCHED &&
      title.status === WatchStatus.WATCHED &&
      newWatchedAt != null &&
      newWatchedAt.getTime() !== title.watchedAt?.getTime();

    const updateData: Prisma.TitleUpdateInput = {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...ratingUpdate,
      ...(input.notes !== undefined
        ? { notes: input.notes == null ? null : input.notes.slice(0, 2000) }
        : {}),
      ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
      ...(input.watchedAt !== undefined
        ? { watchedAt: submittedWatchedAt ?? null }
        : {}),
      ...(autoWatchedAt ? { watchedAt: autoWatchedAt } : {}),
    };

    // Completing a TV title from its status select also settles every aired
    // episode. Title-first locking keeps this ordered with all tracker writes.
    if (input.status === WatchStatus.WATCHED && (title.totalEpisodes ?? 0) > 0) {
      const episodeWatchedAt = completionAt ?? newWatchedAt ?? now;
      const unwatchedAired = {
        season: { titleId: id },
        watched: false,
        ...airedEpisodeFilter(now),
      };
      const toWatch = await tx.episode.findMany({
        where: unwatchedAired,
        select: { id: true },
      });
      await tx.episode.updateMany({
        where: unwatchedAired,
        data: { watched: true, watchedAt: episodeWatchedAt },
      });
      if (toWatch.length) {
        await tx.watchEvent.createMany({
          data: toWatch.map((episode) => ({
            userId,
            titleId: id,
            episodeId: episode.id,
            kind: WatchEventKind.EPISODE_WATCHED,
            occurredAt: episodeWatchedAt,
            source: WatchEventSource.BULK,
          })),
        });
      }
      const [episodeRows, watchedEpisodes] = await Promise.all([
        tx.episode.count({
          where: { season: { titleId: id }, ...ACTIVE_EPISODE_FILTER },
        }),
        tx.episode.count({
          where: { season: { titleId: id }, watched: true, ...ACTIVE_EPISODE_FILTER },
        }),
      ]);
      await tx.title.update({
        where: { id },
        // Some imported TV rows intentionally carry aggregate progress without
        // materialized Episode rows. Marking one WATCHED must keep that only
        // durable counter instead of replacing it with a zero-row recount.
        data: {
          ...updateData,
          ...(episodeRows > 0 ? { watchedEpisodes } : {}),
        },
      });
    } else {
      await tx.title.update({ where: { id }, data: updateData });
    }

    if (logsCompletion) {
      await tx.watchEvent.create({
        data: {
          userId,
          titleId: id,
          kind: WatchEventKind.TITLE_COMPLETED,
          occurredAt: completionAt!,
          source: reversibleTvCompletion
            ? WatchEventSource.BULK
            : WatchEventSource.MANUAL,
        },
      });
    } else if (redatesCompletion) {
      const latest = await tx.watchEvent.findFirst({
        where: {
          userId,
          titleId: id,
          kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
        },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (latest && newWatchedAt) {
        await tx.watchEvent.update({
          where: { id: latest.id },
          data: { occurredAt: newWatchedAt },
        });
        await syncWatchedAtFromEvents(tx, id, newWatchedAt);
      }
    } else if (
      input.watchedAt === null &&
      nextStatus === WatchStatus.WATCHED
    ) {
      await syncWatchedAtFromEvents(tx, id, null);
    }
    // Undo restores the owner's date without this transition's auto-stamp: the
    // one submitted with this request, else the row's value before it.
    const restoreWatchedAt =
      input.watchedAt !== undefined ? submittedWatchedAt : title.watchedAt;
    return {
      undoWatchedAt:
        reversibleTvCompletion && completionAt ? completionAt.toISOString() : undefined,
      restoreWatchedAt: restoreWatchedAt?.toISOString() ?? null,
      // The locked row's status before this transition, for undo to put back.
      restoreStatus: title.status,
    };
  });
  if (!found) return { error: "Title not found." };
  revalidateAll();
  return found.undoWatchedAt
    ? {
        undo: {
          titleId: id,
          occurredAt: found.undoWatchedAt,
          restoreWatchedAt: found.restoreWatchedAt,
          restoreStatus: found.restoreStatus,
        },
      }
    : {};
}

/**
 * D-019: undo one TV status transition to WATCHED. updateTitle gives every
 * event from that transition the same title, BULK source and completion instant,
 * which is enough identity for a short-lived toast action without a schema
 * migration. Episodes are only unticked while their current watchedAt still
 * equals that instant, protecting a later correction made before Undo is used.
 * The title's watchedAt returns to the token's restoreWatchedAt under the same
 * guard, which takes back an auto-stamp without clearing a date the owner set,
 * then follows any surviving viewing as syncWatchedAtFromEvents does elsewhere.
 * The status returns to the token's restoreStatus while the title is still
 * WATCHED, as long as the progress left after the undo allows it. A status
 * chosen since the mark is left alone.
 */
export async function undoWatchedTransition(
  titleId: string,
  occurredAt: string,
  restoreWatchedAt: string | null,
  restoreStatus: WatchStatus,
): Promise<{ ok?: true; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = undoWatchedTransitionSchema.safeParse({
    titleId,
    occurredAt,
    restoreWatchedAt,
    restoreStatus,
  });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const transitionAt = toDate(parsed.data.occurredAt);
  if (!transitionAt) return { error: "Invalid request. Refresh and try again." };
  const restoreAt = toDate(parsed.data.restoreWatchedAt);

  const undone = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      {
        id: string;
        userId: string;
        status: WatchStatus;
        watchedAt: Date | null;
        watchedEpisodes: number;
        totalEpisodes: number | null;
        mediaType: MediaType;
      }[]
    >`SELECT id, "userId", status, "watchedAt", "watchedEpisodes", "totalEpisodes", "mediaType"
      FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const title = rows[0];
    if (!title || title.mediaType !== MediaType.TV) return false;

    const transitionEvents = await tx.watchEvent.findMany({
      where: {
        userId,
        titleId,
        source: WatchEventSource.BULK,
        occurredAt: transitionAt,
        kind: {
          in: [WatchEventKind.EPISODE_WATCHED, WatchEventKind.TITLE_COMPLETED],
        },
      },
      select: { kind: true, episodeId: true },
    });
    // A completion is the authority that this instant identifies a status
    // transition, rather than an unrelated season/show bulk episode gesture.
    if (!transitionEvents.some((event) => event.kind === WatchEventKind.TITLE_COMPLETED)) {
      return false;
    }

    const episodeIds = transitionEvents.flatMap((event) =>
      event.kind === WatchEventKind.EPISODE_WATCHED && event.episodeId
        ? [event.episodeId]
        : [],
    );
    if (episodeIds.length) {
      await tx.episode.updateMany({
        where: {
          id: { in: episodeIds },
          season: { titleId },
          watched: true,
          watchedAt: transitionAt,
        },
        data: { watched: false, watchedAt: null },
      });
    }
    await tx.watchEvent.deleteMany({
      where: {
        userId,
        titleId,
        source: WatchEventSource.BULK,
        occurredAt: transitionAt,
        kind: {
          in: [WatchEventKind.EPISODE_WATCHED, WatchEventKind.TITLE_COMPLETED],
        },
      },
    });
    // Restore the token's date only while watchedAt still holds this instant: a
    // later change (say a newer logged watch) owns it, as with the episodes. Then
    // raise it to any viewing that survives the undo (a back-dated log). Done
    // before the recount, so one that re-completes the title stamps a fresh date.
    if (title.watchedAt?.getTime() === transitionAt.getTime()) {
      await tx.title.update({
        where: { id: titleId },
        data: { watchedAt: restoreAt },
      });
      await syncWatchedAtFromEvents(tx, titleId, restoreAt);
    }
    // Status. If the title is no longer WATCHED, the owner chose a status after
    // the mark, and the undo leaves it alone: only the episode count follows the
    // unticks. While it is still WATCHED, the token's prior status comes back
    // wherever progressStatus would keep it for the progress the undo leaves.
    // Otherwise the recount decides, which is intended and matches the progress
    // rule: WATCHLIST with episodes still ticked comes back WATCHING, and on a
    // show with Episode rows, WATCHING or WATCHLIST over a run whose every
    // episode was already ticked before Mark watched stays WATCHED.
    const priorStatus =
      title.status === WatchStatus.WATCHED ? parsed.data.restoreStatus : undefined;

    const episodeRows = await tx.episode.count({ where: { season: { titleId } } });
    if (priorStatus === undefined) {
      if (episodeRows > 0) {
        const watchedEpisodes = await tx.episode.count({
          where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
        });
        await tx.title.update({ where: { id: titleId }, data: { watchedEpisodes } });
      }
    } else if (episodeRows > 0) {
      await recomputeProgress(tx, titleId, title, priorStatus);
    } else {
      // Imported TV titles can carry aggregate progress without materialized
      // Episode rows. Preserve that counter and restore its natural non-complete
      // state instead of recounting it to zero.
      const keepsPrior =
        progressStatus(priorStatus, title.watchedEpisodes, title.totalEpisodes ?? 0) ===
        priorStatus;
      await tx.title.update({
        where: { id: titleId },
        data: {
          status: keepsPrior
            ? priorStatus
            : title.watchedEpisodes > 0
              ? WatchStatus.WATCHING
              : WatchStatus.WATCHLIST,
        },
      });
    }
    return true;
  });

  if (!undone) return { error: "That watched change is no longer available to undo." };
  revalidateAll();
  return { ok: true };
}

/**
 * D-F2: record an explicit viewing. The first surviving completion is a
 * TITLE_COMPLETED and later viewings are REWATCH events. A
 * partly watched TV title is directed to the episode tracker: the generic log
 * has no episode coordinate and therefore cannot honestly record either an
 * episode or the whole-series completion. Title-FOR-UPDATE-first keeps the
 * event, status/date cache and returned completion count consistent.
 */
export async function logWatch(
  titleId: string,
  input: { occurredAt: string; note?: string | null },
): Promise<{ ok?: boolean; watchCount?: number; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = logWatchSchema.safeParse({
    titleId,
    occurredAt: input.occurredAt,
    note: input.note,
  });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const occurred = await toViewingDate(userId, parsed.data.occurredAt);
  if (!occurred) return { error: "Invalid request. Refresh and try again." };
  const trimmed = parsed.data.note?.trim();
  const note = trimmed ? trimmed.slice(0, 500) : null;

  const result = await prisma.$transaction(async (tx) => {
    // Lock + authorize in one shot: the FOR UPDATE row is both the lock and the
    // ownership check. Siblings (updateTitle / episode marks) lock Title first too.
    const rows = await tx.$queryRaw<
      {
        status: WatchStatus;
        watchedAt: Date | null;
        totalEpisodes: number | null;
        watchedEpisodes: number;
      }[]
    >`SELECT status, "watchedAt", "totalEpisodes", "watchedEpisodes" FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const row = rows[0];
    if (!row) return null; // not found or not owned

    const partiallyWatchedTv =
      row.totalEpisodes !== null &&
      row.totalEpisodes > 0 &&
      row.watchedEpisodes < row.totalEpisodes;
    if (partiallyWatchedTv && row.status !== WatchStatus.WATCHED) {
      return {
        error:
          "This show is still in progress. Log individual episodes from the episode tracker instead.",
      };
    }
    const priorWatchCount = await tx.watchEvent.count({
      where: {
        userId,
        titleId,
        kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
      },
    });
    const kind =
      priorWatchCount === 0 ? WatchEventKind.TITLE_COMPLETED : WatchEventKind.REWATCH;
    await tx.watchEvent.create({
      data: {
        userId,
        titleId,
        kind,
        occurredAt: occurred,
        source: WatchEventSource.MANUAL,
        note,
      },
    });

    // Advance the cache forward only: a back-dated log keeps the later date.
    const nextWatchedAt =
      row.watchedAt && row.watchedAt.getTime() >= occurred.getTime()
        ? row.watchedAt
        : occurred;

    await tx.title.update({
      where: { id: titleId },
      data: { status: WatchStatus.WATCHED, watchedAt: nextWatchedAt },
    });

    return { watchCount: priorWatchCount + 1 };
  });

  if (!result) return { error: "Title not found." };
  if ("error" in result) return result;
  revalidateAll();
  return { ok: true, watchCount: result.watchCount };
}

/**
 * Re-derive a title's `watchedAt` cache from its surviving completion/rewatch
 * events. Call inside a transaction that already holds the Title row lock.
 *
 * The cache keeps the latest known viewing date. That can be newer than the
 * surviving log because imports and legacy titles carry dates without events.
 * Editing or deleting history must not move that durable date backward.
 *
 * When NO completion event survives, the date is left exactly as it is rather
 * than cleared. The log is not the only thing that writes `watchedAt`: a
 * spreadsheet import seats a real, owner-supplied watch date without writing an
 * event, and titles predating the event log carry dates the log never knew
 * about. Clearing on an empty log would let "remove one mis-tapped rewatch"
 * silently erase a completion date from years earlier that nothing else records
 * — unrecoverable, and never what the owner asked for. A stale-looking date is
 * the strictly safer failure, and the owner can still change it directly.
 */
async function syncWatchedAtFromEvents(
  tx: Prisma.TransactionClient,
  titleId: string,
  currentWatchedAt: Date | null,
): Promise<void> {
  const latest = await tx.watchEvent.findFirst({
    where: {
      titleId,
      kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: { occurredAt: true },
  });
  const nextWatchedAt =
    latest && (!currentWatchedAt || latest.occurredAt > currentWatchedAt)
      ? latest.occurredAt
      : currentWatchedAt;
  if (!nextWatchedAt) return;
  await tx.title.update({
    where: { id: titleId },
    data: { watchedAt: nextWatchedAt },
  });
}

/**
 * D-F2: correct a logged viewing — its date, its note, or both. A watch logged
 * on the wrong day previously could not be fixed from the app at all; it stayed
 * in the append-only log inflating streaks, the heatmap and the rewatch count
 * with no route to repair short of touching the database by hand.
 */
export async function updateWatchEvent(
  eventId: string,
  input: { occurredAt: string; note?: string | null },
): Promise<{ ok?: boolean; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = watchEventEditSchema.safeParse({
    eventId,
    occurredAt: input.occurredAt,
    note: input.note,
  });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const occurred = await toViewingDate(userId, parsed.data.occurredAt);
  if (!occurred) return { error: "Invalid request. Refresh and try again." };
  const noteInput = parsed.data.note;
  const trimmedNote = noteInput?.trim();
  const noteUpdate =
    noteInput === undefined
      ? {}
      : { note: trimmedNote ? trimmedNote.slice(0, 500) : null };

  const event = await prisma.watchEvent.findFirst({
    where: { id: eventId, userId },
    select: { id: true, titleId: true, occurredAt: true },
  });
  if (!event) return { error: "Watch not found." };

  await prisma.$transaction(async (tx) => {
    // Title lock first (invariant), so the event edit and the cache resync are
    // one unit and can't interleave with a concurrent logWatch on this title.
    const rows = await tx.$queryRaw<{ id: string; watchedAt: Date | null }[]>`
      SELECT id, "watchedAt" FROM "Title" WHERE id = ${event.titleId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return; // title removed concurrently
    await tx.watchEvent.update({
      where: { id: event.id },
      data: { occurredAt: occurred, ...noteUpdate },
    });
    const currentWatchedAt =
      title.watchedAt?.getTime() === event.occurredAt.getTime()
        ? occurred
        : title.watchedAt;
    await syncWatchedAtFromEvents(tx, event.titleId, currentWatchedAt);
  });

  revalidateAll();
  return { ok: true };
}

/**
 * Delete a logged viewing (a duplicate, or one recorded by mistake). Scoped to
 * the owner's own events; the title's watch date is re-derived from whatever
 * remains. Returns the surviving completion+rewatch count so the caller can
 * update the "Watched n times" badge without a refetch.
 */
export async function deleteWatchEvent(
  eventId: string,
): Promise<{ ok?: boolean; watchCount?: number; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = watchEventIdSchema.safeParse({ eventId });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };

  const event = await prisma.watchEvent.findFirst({
    where: { id: eventId, userId },
    select: { id: true, titleId: true, occurredAt: true },
  });
  if (!event) return { error: "Watch not found." };

  const watchCount = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; watchedAt: Date | null }[]>`
      SELECT id, "watchedAt" FROM "Title" WHERE id = ${event.titleId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return 0; // title removed concurrently
    await tx.watchEvent.delete({ where: { id: event.id } });
    await syncWatchedAtFromEvents(
      tx,
      event.titleId,
      title.watchedAt?.getTime() === event.occurredAt.getTime()
        ? null
        : title.watchedAt,
    );
    return tx.watchEvent.count({
      where: {
        titleId: event.titleId,
        kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
      },
    });
  });

  revalidateAll();
  return { ok: true, watchCount };
}

export async function removeTitle(id: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  // Soft delete: move the title to Trash (stamp deletedAt) instead of hard
  // deleting, so it can be restored — with every piece of personal data intact
  // (status/rating/notes/tags/episode progress) — from the library's Trash view.
  // purgeTitle performs the permanent, cascading delete. Scoping to
  // `deletedAt: null` makes a repeat remove a no-op, preserving the first
  // deletion time shown in Trash.
  await prisma.title.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  revalidateAll();
  return {};
}

export async function restoreTitle(id: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  // Clear the soft-delete flag. Nothing else was touched on delete, so the title
  // returns exactly as it was. Scoped to already-trashed rows (and the user) so a
  // stray call can't perturb a live title.
  await prisma.title.updateMany({
    where: { id, userId, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  revalidateAll();
  return {};
}

export async function purgeTitle(id: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  // Permanent delete. Season/Episode/WatchEvent/TitleTag/ShareListItem rows cascade
  // (onDelete: Cascade); ImportItem.titleId is set null. Restricted to rows already
  // in Trash so the only route to a hard delete is remove-then-purge — a live title
  // can never be destroyed in one step, and a purge racing a concurrent restore
  // safely no-ops rather than nuking the just-restored title.
  await prisma.title.deleteMany({ where: { id, userId, deletedAt: { not: null } } });
  revalidateAll();
  return {};
}

/**
 * Permanently delete every title currently in Trash. Same one-way guarantees as
 * purgeTitle — restricted to rows already soft-deleted, so a live title can
 * never be destroyed by this call, and a concurrent restore simply removes that
 * row from the set rather than racing it back out of existence.
 *
 * Exists because emptying a Trash that accumulated a few hundred rows from a
 * bulk remove was otherwise one confirmation dialog per title, and every
 * lingering row keeps occupying its (userId, mediaType, tmdbId) slot — which
 * silently blocks re-adding that title from search.
 */
export async function emptyTrash(): Promise<{ count?: number; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const res = await prisma.title.deleteMany({
    where: { userId, deletedAt: { not: null } },
  });
  revalidateAll();
  return { count: res.count };
}

// --- Episode / season tracking ---------------------------------------------

export async function setEpisodeWatched(episodeId: string, watched: boolean) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = episodeToggleSchema.safeParse({ episodeId, watched });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const ep = await prisma.episode.findFirst({
    where: { id: episodeId, season: { title: { userId } } },
    select: { id: true, season: { select: { titleId: true } } },
  });
  if (!ep) return { error: "Episode not found." };
  const titleId = ep.season.titleId;

  // Flip the episode flag and its WatchEvent together, under a Title lock taken
  // first (invariant) so this serializes against the season / all / bulk marks
  // and can't race their snapshot-then-update. recomputeProgress then reconciles
  // the denormalized counter and natural status.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedProgressTitle[]>`
      SELECT "userId", status, "watchedAt" FROM "Title"
      WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return; // title removed concurrently
    // Reread the episode after acquiring the Title lock. A repeated set-style
    // request is a no-op, and a rematch that replaced the episode while this
    // request waited cannot make us write an event for a vanished row.
    const current = await tx.episode.findFirst({
      where: { id: episodeId, season: { titleId } },
      select: { watched: true },
    });
    if (current && current.watched !== watched) {
      const now = new Date();
      await tx.episode.update({
        where: { id: episodeId },
        data: { watched, watchedAt: watched ? now : null },
      });
      if (watched) {
        await tx.watchEvent.create({
          data: {
            userId,
            titleId,
            episodeId,
            kind: WatchEventKind.EPISODE_WATCHED,
            occurredAt: now,
            source: WatchEventSource.MANUAL,
          },
        });
      } else {
        // A real true -> false transition removes every generated, un-noted
        // set-state event. This also cleans duplicates created by the former
        // stale-read path; noted history and explicit REWATCH records survive.
        await tx.watchEvent.deleteMany({
          where: {
            userId,
            titleId,
            episodeId,
            kind: WatchEventKind.EPISODE_WATCHED,
            source: { in: [WatchEventSource.MANUAL, WatchEventSource.BULK] },
            note: null,
          },
        });
      }
    }
    await recomputeProgress(tx, titleId, title);
  });
  revalidateAll();
  return {};
}

export async function setSeasonWatched(seasonId: string, watched: boolean) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = seasonToggleSchema.safeParse({ seasonId, watched });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const season = await prisma.season.findFirst({
    where: { id: seasonId, title: { userId } },
    select: { titleId: true },
  });
  if (!season) return { error: "Season not found." };
  const titleId = season.titleId;

  // Both directions take the same Title-first lock. The old false branch was a
  // bare updateMany, so it could interleave with rematch/restore and clear rows
  // from one generation while a replacement generation restored stale flags.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedProgressTitle[]>`
      SELECT "userId", status, "watchedAt" FROM "Title"
      WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return; // title removed concurrently
    if (watched) {
      const now = new Date();
      const unwatchedAired = { seasonId, watched: false, ...airedEpisodeFilter(now) };
      const toWatch = await tx.episode.findMany({
        where: unwatchedAired,
        select: { id: true },
      });
      if (toWatch.length) {
        await tx.episode.updateMany({
          where: unwatchedAired,
          data: { watched: true, watchedAt: now },
        });
        await tx.watchEvent.createMany({
          data: toWatch.map((e) => ({
            userId,
            titleId,
            episodeId: e.id,
            kind: WatchEventKind.EPISODE_WATCHED,
            occurredAt: now,
            source: WatchEventSource.BULK,
          })),
        });
      }
    } else {
      // Bulk demotion preserves historical events by design; it only clears
      // episode state, and only rows that genuinely transition.
      await tx.episode.updateMany({
        where: { seasonId, watched: true, ...ACTIVE_EPISODE_FILTER },
        data: { watched: false, watchedAt: null },
      });
    }
    await recomputeProgress(tx, titleId, title);
  });
  revalidateAll();
  return {};
}

export async function setAllEpisodesWatched(titleId: string, watched: boolean) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = allEpisodesSchema.safeParse({ titleId, watched });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const title = await prisma.title.findFirst({
    where: { id: titleId, userId },
    select: { id: true },
  });
  if (!title) return { error: "Title not found." };

  // As with the season action, serialize both directions with rematch/restore
  // and every other episode writer by taking the Title lock first.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedProgressTitle[]>`
      SELECT "userId", status, "watchedAt" FROM "Title"
      WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const locked = rows[0];
    if (!locked) return; // title removed concurrently
    if (watched) {
      const now = new Date();
      const unwatchedAired = {
        season: { titleId },
        watched: false,
        ...airedEpisodeFilter(now),
      };
      const toWatch = await tx.episode.findMany({
        where: unwatchedAired,
        select: { id: true },
      });
      if (toWatch.length) {
        await tx.episode.updateMany({
          where: unwatchedAired,
          data: { watched: true, watchedAt: now },
        });
        await tx.watchEvent.createMany({
          data: toWatch.map((e) => ({
            userId,
            titleId,
            episodeId: e.id,
            kind: WatchEventKind.EPISODE_WATCHED,
            occurredAt: now,
            source: WatchEventSource.BULK,
          })),
        });
      }
    } else {
      // Preserve historical events, but touch only true -> false rows.
      await tx.episode.updateMany({
        where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
        data: { watched: false, watchedAt: null },
      });
    }
    await recomputeProgress(tx, titleId, locked);
  });
  revalidateAll();
  return {};
}

/**
 * Mark every aired episode in a season up to and including `episodeId` as
 * watched. Catching up on a season used to mean one server round trip per
 * episode (19 requests to get through a 20-episode season, each one revalidating
 * three routes); this is a single transaction and a single revalidation.
 *
 * Season-scoped on purpose: "I'm up to here" is a statement about the season
 * you're looking at. Earlier seasons are left alone — "Mark show watched"
 * already covers the whole-series case, and silently reaching backwards across
 * seasons would be far harder to undo than to repeat.
 *
 * Returns how many episodes it actually changed so the caller can report it.
 */
export async function setEpisodesWatchedThrough(
  episodeId: string,
): Promise<{ count?: number; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = episodesThroughSchema.safeParse({ episodeId });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };

  const anchor = await prisma.episode.findFirst({
    where: { id: episodeId, season: { title: { userId } } },
    select: {
      episodeNumber: true,
      seasonId: true,
      season: { select: { titleId: true } },
    },
  });
  if (!anchor) return { error: "Episode not found." };
  const titleId = anchor.season.titleId;

  const changed = await prisma.$transaction(async (tx) => {
    // Title lock first — the same ordering every other transaction here uses, so
    // this serializes against episode/season/bulk marks instead of racing them.
    const rows = await tx.$queryRaw<LockedProgressTitle[]>`
      SELECT "userId", status, "watchedAt" FROM "Title"
      WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return 0; // title removed concurrently
    const now = new Date();
    const target = {
      seasonId: anchor.seasonId,
      episodeNumber: { lte: anchor.episodeNumber },
      watched: false,
      ...airedEpisodeFilter(now),
    };
    const toWatch = await tx.episode.findMany({ where: target, select: { id: true } });
    if (toWatch.length > 0) {
      await tx.episode.updateMany({
        where: target,
        data: { watched: true, watchedAt: now },
      });
      await tx.watchEvent.createMany({
        data: toWatch.map((e) => ({
          userId,
          titleId,
          episodeId: e.id,
          kind: WatchEventKind.EPISODE_WATCHED,
          occurredAt: now,
          source: WatchEventSource.BULK,
        })),
      });
    }
    await recomputeProgress(tx, titleId, title);
    return toWatch.length;
  });

  revalidateAll();
  return { count: changed };
}

type FetchedSeason = { n: number; sd: TmdbSeasonDetails };

type PriorEpisode = {
  tmdbId: number | null;
  seasonNumber: number;
  episodeNumber: number;
  watched: boolean;
  watchedAt: Date | null;
  withdrawnAt: Date | null;
  discoveredAt: Date;
  name: string | null;
  overview: string | null;
  airDate: Date | null;
  runtime: number | null;
  stillPath: string | null;
  season: {
    tmdbId: number | null;
    name: string | null;
    overview: string | null;
    airDate: Date | null;
    posterPath: string | null;
  };
};

/**
 * Fetches all season details for a TV title from TMDB (network only, no DB
 * writes). `allOk` is false if any listed season failed to load — callers that
 * destroy existing data (re-match) should abort when `allOk` is false so a
 * transient TMDB failure can never wipe a user's progress.
 */
async function fetchSeasonData(
  tvTmdbId: number,
  tv: Awaited<ReturnType<typeof getTv>>,
  opts: { fresh?: boolean } = {},
): Promise<{ seasons: FetchedSeason[]; allOk: boolean }> {
  const listed = tv.seasons
    .filter((s) => s.season_number >= 1)
    .sort((a, b) => a.season_number - b.season_number);

  // Up to 20 seasons ride on one request. The requests are independent, so
  // they run concurrently (bounded, so a very long soap doesn't burst-fire at
  // TMDB). A request that fails counts as its seasons failing to load.
  const fetched = await mapLimit(chunks(listed, MAX_APPENDED_SEASONS), 6, (chunk) =>
    getSeasons(tvTmdbId, chunk, opts).catch(() => []),
  );
  const seasons = fetched.flat();
  return { seasons, allOk: seasons.length === listed.length };
}

/**
 * Writes Season + Episode rows from pre-fetched TMDB data inside a transaction.
 * When `prior` is given, TMDB id is the identity and the mutable season/episode
 * coordinate is only a fallback for legacy rows without one. Watched rows that
 * disappeared are recreated with a withdrawnAt stamp. Genuinely new rows receive
 * a discovery date derived from their air date and the title's age.
 */
async function writeSeasons(
  tx: Prisma.TransactionClient,
  titleId: string,
  seasons: FetchedSeason[],
  titleCreatedAt: Date,
  now: Date,
  prior: PriorEpisode[] = [],
): Promise<void> {
  const priorByTmdbId = new Map(
    prior.flatMap((episode) =>
      episode.tmdbId === null ? [] : [[episode.tmdbId, episode] as const],
    ),
  );
  const legacyByCoordinate = new Map(
    prior
      .filter((episode) => episode.tmdbId === null && episode.withdrawnAt === null)
      .map((episode) => [
        `${episode.seasonNumber}:${episode.episodeNumber}`,
        episode,
      ] as const),
  );
  const matched = new Set<PriorEpisode>();
  const activeCoordinates = new Set(
    seasons.flatMap(({ n, sd }) =>
      (sd.episodes ?? []).map((episode) => `${n}:${episode.episode_number}`),
    ),
  );

  // One INSERT for every season and one for every episode, however long the
  // show. This runs inside the caller's transaction, which holds the Title
  // lock, and a statement per season held that lock for a round trip each.
  // Prisma splits a bulk insert that would pass the database's bind limit.
  const created =
    seasons.length > 0
      ? await tx.season.createManyAndReturn({
          data: seasons.map(({ n, sd }) => ({
            titleId,
            tmdbId: sd.id,
            seasonNumber: n,
            name: sd.name || null,
            overview: sd.overview || null,
            airDate: toDate(sd.air_date),
            posterPath: sd.poster_path,
            episodeCount: sd.episodes?.length ?? null,
          })),
          select: { id: true, seasonNumber: true },
        })
      : [];
  const seasonIds = new Map(created.map((season) => [season.seasonNumber, season.id]));
  const episodeRows = seasons.flatMap(({ n, sd }) =>
    (sd.episodes ?? []).map((ep) => {
      const p =
        priorByTmdbId.get(ep.id) ??
        legacyByCoordinate.get(`${n}:${ep.episode_number}`);
      if (p) matched.add(p);
      const airDate = toDate(ep.air_date);
      return {
        seasonId: seasonIds.get(n)!,
        tmdbId: ep.id,
        episodeNumber: ep.episode_number,
        name: ep.name || null,
        overview: ep.overview || null,
        airDate,
        runtime: ep.runtime ?? null,
        stillPath: ep.still_path,
        watched: p?.watched ?? false,
        watchedAt: p?.watched ? (p.watchedAt ?? null) : null,
        withdrawnAt: null,
        discoveredAt:
          p?.discoveredAt ??
          discoveredAtForNewEpisode(airDate, titleCreatedAt, now),
      };
    }),
  );
  if (episodeRows.length > 0) {
    await tx.episode.createMany({ data: episodeRows });
  }

  // A same-series refresh deletes and rebuilds seasons. Recreate watched rows
  // that TMDB no longer returns so their tick and linked watch events survive.
  // A withdrawn row keeps its coordinate unless an active row now occupies it;
  // that collision is moved to the reserved withdrawn range.
  const withdrawnBySeason = new Map<number, PriorEpisode[]>();
  for (const episode of prior) {
    if (!episode.watched || matched.has(episode)) continue;
    const rows = withdrawnBySeason.get(episode.seasonNumber) ?? [];
    rows.push(episode);
    withdrawnBySeason.set(episode.seasonNumber, rows);
  }
  // Seasons TMDB no longer lists that still hold a watched row: at most one
  // more INSERT for the seasons and one for the rows.
  const missingSeasons = [...withdrawnBySeason].filter(
    ([seasonNumber]) => !seasonIds.has(seasonNumber),
  );
  if (missingSeasons.length > 0) {
    const recreated = await tx.season.createManyAndReturn({
      data: missingSeasons.map(([seasonNumber, episodes]) => {
        const exemplar = episodes[0];
        return {
          titleId,
          seasonNumber,
          tmdbId: exemplar.season.tmdbId,
          name: exemplar.season.name,
          overview: exemplar.season.overview,
          airDate: exemplar.season.airDate,
          posterPath: exemplar.season.posterPath,
          episodeCount: 0,
        };
      }),
      select: { id: true, seasonNumber: true },
    });
    for (const season of recreated) seasonIds.set(season.seasonNumber, season.id);
  }
  const withdrawnRows = [...withdrawnBySeason].flatMap(([seasonNumber, episodes]) =>
    episodes.map((episode) => ({
      seasonId: seasonIds.get(seasonNumber)!,
      tmdbId: episode.tmdbId,
      episodeNumber: activeCoordinates.has(
        `${episode.seasonNumber}:${episode.episodeNumber}`,
      )
        ? episode.episodeNumber + WITHDRAWN_EPISODE_NUMBER_OFFSET
        : episode.episodeNumber,
      name: episode.name,
      overview: episode.overview,
      airDate: episode.airDate,
      runtime: episode.runtime,
      stillPath: episode.stillPath,
      watched: true,
      watchedAt: episode.watchedAt,
      withdrawnAt: episode.withdrawnAt ?? now,
      discoveredAt: episode.discoveredAt,
    })),
  );
  if (withdrawnRows.length > 0) {
    await tx.episode.createMany({ data: withdrawnRows });
  }
}

// --- Add from TMDB ---------------------------------------------------------

export async function addFromTmdb(
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<{
  id?: string;
  error?: string;
  existing?: boolean;
  warning?: string;
  restored?: boolean;
}> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = addFromTmdbSchema.safeParse({ tmdbId, mediaType });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const mt = mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;

  const dup = await prisma.title.findUnique({
    where: { userId_mediaType_tmdbId: { userId, mediaType: mt, tmdbId } },
    select: { id: true, deletedAt: true },
  });
  if (dup) {
    // A trashed row still occupies the (userId, mediaType, tmdbId) unique slot, so
    // re-adding the same title collides with it. Treat that as a restore: clear the
    // soft-delete flag and keep all personal data (ratings, notes, progress).
    if (dup.deletedAt) {
      await prisma.title.update({ where: { id: dup.id }, data: { deletedAt: null } });
      revalidateAll();
      return { id: dup.id, restored: true };
    }
    return { id: dup.id, existing: true };
  }

  try {
    if (mt === MediaType.MOVIE) {
      const m = await getMovie(tmdbId, { fresh: true });
      const created = await prisma.title.create({
        data: {
          userId,
          tmdbId,
          mediaType: mt,
          name: m.title,
          originalName: m.original_title || null,
          overview: m.overview || null,
          releaseDate: toDate(m.release_date),
          posterPath: m.poster_path,
          backdropPath: m.backdrop_path,
          language: m.original_language || null,
          tmdbRating: m.vote_average ?? null,
          runtime: m.runtime ?? null,
          genres: m.genres?.map((g) => g.name) ?? [],
          status: WatchStatus.WATCHLIST,
          source: "tmdb",
        },
      });
      revalidateAll();
      return { id: created.id };
    }

    const now = new Date();
    const tv = await getTv(tmdbId, { fresh: true });
    // Fetch all season data before any DB writes, then persist atomically. Unlike
    // re-match (which aborts on partial data to protect existing progress), a
    // fresh add has nothing to lose: on a partial TMDB failure we still create the
    // title from the seasons that DID load and return a warning so the user can
    // refresh later. The denormalized counts below are reconciled from the rows
    // actually stored, so they never claim more seasons/episodes than were saved.
    const { seasons, allOk } = await fetchSeasonData(tmdbId, tv, { fresh: true });
    const created = await prisma.$transaction(
      async (tx) => {
        const t = await tx.title.create({
          data: {
            userId,
            tmdbId,
            mediaType: mt,
            name: tv.name,
            originalName: tv.original_name || null,
            overview: tv.overview || null,
            releaseDate: toDate(tv.first_air_date),
            posterPath: tv.poster_path,
            backdropPath: tv.backdrop_path,
            language: tv.original_language || null,
            tmdbRating: tv.vote_average ?? null,
            runtime: tv.episode_run_time?.[0] ?? null,
            genres: tv.genres?.map((g) => g.name) ?? [],
            // On a complete load, keep TMDB's authoritative season count; on a
            // partial load, fall back to the number of seasons actually stored so
            // totalSeasons never overstates what was tracked.
            totalSeasons: allOk ? (tv.number_of_seasons ?? null) : seasons.length,
            tmdbStatus: tv.status ?? null,
            nextEpisodeAirDate: deriveNextEpisodeAirDate(
              tv.next_episode_to_air?.air_date,
              seasons.map((s) => s.sd),
              now,
            ),
            // Only a complete load counts as synced. A partial one stays
            // never-synced, so the scheduled sync takes it first and fills in
            // the missing seasons instead of sending it to the back of the queue.
            ...(allOk
              ? { metadataSyncedAt: now, metadataSyncState: MetadataSyncState.OK }
              : {}),
            status: WatchStatus.WATCHLIST,
            source: "tmdb",
          },
        });
        await writeSeasons(tx, t.id, seasons, t.createdAt, now);
        // totalEpisodes from the rows we actually created.
        const epTotal = await tx.episode.count({
          where: { season: { titleId: t.id }, ...ACTIVE_EPISODE_FILTER },
        });
        await tx.title.update({
          where: { id: t.id },
          data: { totalEpisodes: epTotal },
        });
        return t;
      },
      { timeout: 20000 },
    );

    revalidateAll();
    return allOk
      ? { id: created.id }
      : {
          id: created.id,
          warning:
            "Some season data could not be loaded. Refresh metadata on the title page to retry.",
        };
  } catch (err) {
    // A concurrent add of the same title can slip between the dup pre-check and
    // create(), tripping the @@unique([userId, mediaType, tmdbId]) constraint.
    // Treat that specific unique violation as the existing-item case (same shape
    // the pre-check returns) instead of surfacing a raw P2002 to the UI.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await prisma.title.findUnique({
        where: { userId_mediaType_tmdbId: { userId, mediaType: mt, tmdbId } },
        select: { id: true, deletedAt: true },
      });
      if (existing) {
        // Same restore-vs-duplicate split as the pre-check, for a row that slipped
        // in between the pre-check and create() (including a concurrently trashed one).
        if (existing.deletedAt) {
          await prisma.title.update({
            where: { id: existing.id },
            data: { deletedAt: null },
          });
          revalidateAll();
          return { id: existing.id, restored: true };
        }
        return { id: existing.id, existing: true };
      }
    }
    console.error(
      `addFromTmdb failed (tmdbId=${tmdbId}, mediaType=${mediaType}):`,
      err,
    );
    // Never surface the raw error to the client — it can carry TMDB response
    // bodies or ORM internals. The specific, actionable cases (invalid input,
    // duplicate, and the unique-constraint race handled above) already returned
    // their own copy; everything else is an opaque failure to the user.
    return { error: "Celluloid couldn't load title data. Try again in a moment." };
  }
}

// --- Re-match / refresh a title's TMDB link --------------------------------

/**
 * Provider ids are cached per TMDB entry, so after a re-match to a different
 * entry they describe the old one. Clearing them also puts the title at the
 * head of the scheduled sync's provider queue.
 */
const CLEARED_PROVIDER_CACHE = {
  streamProviderIds: [] as number[],
  providersRegion: null,
  providersSyncedAt: null,
};

/**
 * Re-links a title to a (possibly different) TMDB entry and refreshes its
 * metadata, preserving title-level personal tracking. A refresh of the same TV
 * series also preserves episode progress and event links by season/episode
 * number; a genuine re-match keeps the historical events but detaches their
 * now-meaningless episode ids. Also used to refresh metadata in place by
 * passing the title's current tmdbId.
 */
export async function rematchTitle(
  titleId: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<{ ok?: boolean; error?: string; existingId?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = rematchSchema.safeParse({ titleId, tmdbId, mediaType });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const current = await prisma.title.findFirst({
    where: { id: titleId, userId },
    select: { id: true },
  });
  if (!current) return { error: "Title not found." };

  const mt = mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
  const clash = await prisma.title.findFirst({
    where: { userId, mediaType: mt, tmdbId, NOT: { id: titleId } },
    select: { id: true, deletedAt: true },
  });
  if (clash) {
    // A trashed row still occupies that tmdbId — pointing the caller at its
    // (inaccessible) title page would be a dead end, so send them to Trash
    // instead of the generic "already in your library" message.
    if (clash.deletedAt) {
      return {
        error: "That title is in your Trash. Restore or delete it there first.",
      };
    }
    return { error: "That title is already in your library.", existingId: clash.id };
  }

  try {
    if (mt === MediaType.MOVIE) {
      const m = await getMovie(tmdbId, { fresh: true });
      const found = await prisma.$transaction(async (tx) => {
        // Lock the Title row FIRST so locks are taken Title-then-Episode, the
        // same order every other transaction in this file uses. season.deleteMany
        // cascades onto Episode (onDelete: Cascade), so running it before the
        // Title lock would lock Episode rows first and invert the order against a
        // concurrent recompute / bulkSetStatus, risking a deadlock.
        const rows = await tx.$queryRaw<
          { id: string; tmdbId: number | null; mediaType: MediaType }[]
        >`
          SELECT id, "tmdbId", "mediaType" FROM "Title"
          WHERE id = ${titleId} AND "userId" = ${userId}
          FOR UPDATE`;
        const locked = rows[0];
        if (!locked) return false; // title removed concurrently
        const sameEntry =
          locked.mediaType === MediaType.MOVIE && locked.tmdbId === tmdbId;
        await tx.season.deleteMany({ where: { titleId } }); // in case it was a TV match
        await tx.title.update({
          where: { id: titleId },
          data: {
            tmdbId,
            mediaType: MediaType.MOVIE,
            name: m.title,
            originalName: m.original_title || null,
            overview: m.overview || null,
            releaseDate: toDate(m.release_date),
            posterPath: m.poster_path,
            backdropPath: m.backdrop_path,
            language: m.original_language || null,
            tmdbRating: m.vote_average ?? null,
            runtime: m.runtime ?? null,
            genres: m.genres?.map((g) => g.name) ?? [],
            totalSeasons: null,
            totalEpisodes: null,
            watchedEpisodes: 0,
            // TV lifecycle and TV sync state from an earlier TV match mean
            // nothing for a movie. Left behind, the Airing page would list it
            // on the old show's date and Settings would list it as failed.
            tmdbStatus: null,
            nextEpisodeAirDate: null,
            metadataSyncedAt: null,
            metadataSyncState: null,
            metadataLastError: null,
            ...(sameEntry ? {} : CLEARED_PROVIDER_CACHE),
            source: "tmdb",
          },
        });
        return true;
      });
      if (!found) return { error: "Title not found." };
    } else {
      const now = new Date();
      const tv = await getTv(tmdbId, { fresh: true });
      // Fetch ALL season data before touching the DB. If any season failed to
      // load, abort without deleting anything (never destroy progress on a
      // transient TMDB failure).
      const { seasons, allOk } = await fetchSeasonData(tmdbId, tv, { fresh: true });
      if (!allOk) {
        return {
          error:
            "Couldn't load all season data from TMDB. Nothing was changed, please try again.",
        };
      }
      const runtime = tvRuntime(
        tv.episode_run_time,
        seasons.map((s) => s.sd),
      );

      const found = await prisma.$transaction(
        async (tx) => {
          // Lock the Title row FIRST so locks are taken Title-then-Episode, the
          // same order every other transaction in this file uses. season.deleteMany
          // cascades onto Episode (onDelete: Cascade), so running it before the
          // Title lock would lock Episode rows first and invert the order against
          // a concurrent recompute / bulkSetStatus, risking a deadlock.
          const rows = await tx.$queryRaw<
            {
              id: string;
              userId: string;
              tmdbId: number | null;
              mediaType: MediaType;
              status: WatchStatus;
              watchedAt: Date | null;
              createdAt: Date;
            }[]
          >`
            SELECT id, "userId", "tmdbId", "mediaType", status, "watchedAt", "createdAt"
            FROM "Title"
            WHERE id = ${titleId} AND "userId" = ${userId}
            FOR UPDATE`;
          const locked = rows[0];
          if (!locked) return false; // title removed concurrently

          // Episode coordinates belong only to this exact TMDB series. Take
          // the snapshot after the Title lock so a concurrent episode tick
          // cannot commit between this read and the replacement write.
          const preserveEpisodes = preservesEpisodeHistory(locked, {
            tmdbId,
            mediaType: MediaType.TV,
          });
          const prior: PriorEpisode[] = [];
          const eventCoordinates: EpisodeEventCoordinate[] = [];
          if (preserveEpisodes) {
            const prevEps = await tx.episode.findMany({
              where: { season: { titleId } },
              select: {
                tmdbId: true,
                episodeNumber: true,
                name: true,
                overview: true,
                airDate: true,
                runtime: true,
                stillPath: true,
                watched: true,
                watchedAt: true,
                withdrawnAt: true,
                discoveredAt: true,
                season: {
                  select: {
                    seasonNumber: true,
                    tmdbId: true,
                    name: true,
                    overview: true,
                    airDate: true,
                    posterPath: true,
                  },
                },
                watchEvents: {
                  where: { titleId },
                  select: { id: true },
                },
              },
            });
            for (const episode of prevEps) {
              const seasonNumber = episode.season.seasonNumber;
              prior.push({
                tmdbId: episode.tmdbId,
                seasonNumber,
                episodeNumber: episode.episodeNumber,
                watched: episode.watched,
                watchedAt: episode.watchedAt,
                withdrawnAt: episode.withdrawnAt,
                discoveredAt: episode.discoveredAt,
                name: episode.name,
                overview: episode.overview,
                airDate: episode.airDate,
                runtime: episode.runtime,
                stillPath: episode.stillPath,
                season: {
                  tmdbId: episode.season.tmdbId,
                  name: episode.season.name,
                  overview: episode.season.overview,
                  airDate: episode.season.airDate,
                  posterPath: episode.season.posterPath,
                },
              });
              for (const event of episode.watchEvents) {
                eventCoordinates.push({
                  eventId: event.id,
                  tmdbId: episode.tmdbId,
                  seasonNumber,
                  episodeNumber: episode.episodeNumber,
                });
              }
            }
          }

          await tx.season.deleteMany({ where: { titleId } });
          await tx.title.update({
            where: { id: titleId },
            data: {
              tmdbId,
              mediaType: MediaType.TV,
              name: tv.name,
              originalName: tv.original_name || null,
              overview: tv.overview || null,
              releaseDate: toDate(tv.first_air_date),
              posterPath: tv.poster_path,
              backdropPath: tv.backdrop_path,
              language: tv.original_language || null,
              tmdbRating: tv.vote_average ?? null,
              // A refresh of the same show keeps its stored runtime when
              // neither TMDB nor the episodes state one, as the nightly sync
              // does. After a genuine re-match the stored value belongs to the
              // old entry, so it is cleared instead.
              ...(runtime !== null || !preserveEpisodes ? { runtime } : {}),
              genres: tv.genres?.map((g) => g.name) ?? [],
              totalSeasons: tv.number_of_seasons ?? null,
              // Every season was just loaded (a partial load aborted above), so
              // this is a complete sync of the entry the title now points at.
              // The lifecycle must be the new entry's: an old "Ended" would
              // otherwise keep a watched show out of the sync for good.
              tmdbStatus: tv.status ?? null,
              nextEpisodeAirDate: deriveNextEpisodeAirDate(
                tv.next_episode_to_air?.air_date,
                seasons.map((s) => s.sd),
                now,
              ),
              metadataSyncedAt: now,
              metadataSyncState: MetadataSyncState.OK,
              metadataLastError: null,
              ...(preserveEpisodes ? {} : CLEARED_PROVIDER_CACHE),
              source: "tmdb",
            },
          });
          await writeSeasons(
            tx,
            titleId,
            seasons,
            locked.createdAt,
            now,
            preserveEpisodes ? prior : [],
          );

          if (eventCoordinates.length > 0) {
            const freshEpisodes = await tx.episode.findMany({
              where: { season: { titleId } },
              select: {
                id: true,
                tmdbId: true,
                episodeNumber: true,
                season: { select: { seasonNumber: true } },
              },
            });
            const relinks = planEpisodeEventRelinks(
              preserveEpisodes,
              eventCoordinates,
              freshEpisodes.map((episode) => ({
                episodeId: episode.id,
                tmdbId: episode.tmdbId,
                seasonNumber: episode.season.seasonNumber,
                episodeNumber: episode.episodeNumber,
              })),
            );
            // One statement per batch rather than one per watched episode,
            // which held the Title lock for a round trip each. The titleId and
            // userId predicates keep the write inside the locked title.
            for (const batch of chunks(relinks, RELINK_BATCH_SIZE)) {
              await tx.$executeRaw`
                UPDATE "WatchEvent" AS w
                SET "episodeId" = v.episode_id
                FROM (VALUES ${Prisma.join(
                  batch.map((r) => Prisma.sql`(${r.eventId}::text, ${r.episodeId}::text)`),
                )}) AS v(event_id, episode_id)
                WHERE w.id = v.event_id AND w."titleId" = ${titleId} AND w."userId" = ${userId}`;
            }
          }

          const epTotal = await tx.episode.count({
            where: { season: { titleId }, ...ACTIVE_EPISODE_FILTER },
          });
          const epWatched = await tx.episode.count({
            where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
          });
          // Same-series refreshes preserve manual status. A genuinely different
          // series starts with zero carried ticks and re-applies the central
          // progress rule (while still respecting ON_HOLD and DROPPED).
          await tx.title.update({
            where: { id: titleId },
            data: { totalEpisodes: epTotal, watchedEpisodes: epWatched },
          });
          if (!preserveEpisodes) {
            await recomputeProgress(tx, titleId, locked);
          }
          return true;
        },
        { timeout: 20000 },
      );
      if (!found) return { error: "Title not found." };
    }

    revalidateAll();
    // A metadata refresh is the one write that should also re-pull the title
    // page's TMDB extras (cast, providers, videos), cached under its path tag.
    revalidatePath(`/title/${titleId}`);
    return { ok: true };
  } catch (err) {
    console.error(
      `rematchTitle failed (titleId=${titleId}, tmdbId=${tmdbId}, mediaType=${mediaType}):`,
      err,
    );
    // Never surface the raw error to the client (TMDB bodies / ORM text). The
    // specific cases (invalid input, not found, library clash, partial season
    // load) all returned their own copy before reaching here.
    return { error: "Celluloid couldn't load title data. Try again in a moment." };
  }
}

// --- Bulk operations (library multi-select) --------------------------------

/** Restrict an id list to titles the user actually owns. */
async function ownedTitleIds(userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.title.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function bulkSetStatus(ids: string[], status: WatchStatus) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkStatusSchema.safeParse({ ids, status });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  const owned = await prisma.title.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  const now = new Date();

  if (status === WatchStatus.WATCHED) {
    // Each title is its own bounded transaction: lock, reread, mutate, and log.
    // The former pre-lock `owned` snapshot let concurrent bulk/single requests
    // both decide a title was newly watched and append duplicate completions.
    await mapLimit(owned, 6, ({ id: titleId }) =>
      prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<
          { status: WatchStatus; mediaType: MediaType; watchedAt: Date | null }[]
        >`SELECT status, "mediaType", "watchedAt" FROM "Title"
          WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
        const current = rows[0];
        if (!current) return; // removed or transferred while the request waited

        const transitions = current.status !== WatchStatus.WATCHED;
        const completedAt = current.watchedAt ?? now;
        const autoWatchedAt = transitions && current.watchedAt === null ? now : undefined;
        const episodeWatchedAt = transitions ? completedAt : now;
        if (current.mediaType === MediaType.TV) {
          // Aired episodes only: pre-ticking an unaired episode suppresses its
          // future "New" badge and upcoming entry.
          const unwatchedAired = {
            season: { titleId },
            watched: false,
            ...airedEpisodeFilter(now),
          };
          const toWatch = await tx.episode.findMany({
            where: unwatchedAired,
            select: { id: true },
          });
          await tx.episode.updateMany({
            where: unwatchedAired,
            data: { watched: true, watchedAt: episodeWatchedAt },
          });
          if (toWatch.length) {
            await tx.watchEvent.createMany({
              data: toWatch.map((episode) => ({
                userId,
                titleId,
                episodeId: episode.id,
                kind: WatchEventKind.EPISODE_WATCHED,
                occurredAt: episodeWatchedAt,
                source: WatchEventSource.BULK,
              })),
            });
          }
          const [episodeRows, watchedEpisodes] = await Promise.all([
            tx.episode.count({
              where: { season: { titleId }, ...ACTIVE_EPISODE_FILTER },
            }),
            tx.episode.count({
              where: { season: { titleId }, watched: true, ...ACTIVE_EPISODE_FILTER },
            }),
          ]);
          await tx.title.update({
            where: { id: titleId },
            data: {
              status,
              // Preserve aggregate-only imports whose progress cannot be
              // reconstructed until episode metadata is materialized.
              ...(episodeRows > 0 ? { watchedEpisodes } : {}),
              ...(autoWatchedAt ? { watchedAt: autoWatchedAt } : {}),
            },
          });
        } else {
          await tx.title.update({
            where: { id: titleId },
            data: { status, ...(autoWatchedAt ? { watchedAt: autoWatchedAt } : {}) },
          });
        }

        if (transitions) {
          await tx.watchEvent.create({
            data: {
              userId,
              titleId,
              kind: WatchEventKind.TITLE_COMPLETED,
              occurredAt: completedAt,
              source: WatchEventSource.BULK,
            },
          });
        }
      }),
    );
  } else {
    // Any demotion (WATCHLIST / WATCHING / ON_HOLD / DROPPED): set the enum only
    // and leave episode rows, watchedEpisodes and watchedAt untouched — exact
    // parity with single-title updateTitle, which never clears progress on a
    // demote. WATCHLIST used to run a per-title transaction that wiped every
    // episode and zeroed the counter; that diverged from the single-title path
    // and silently discarded a user's watch history on a bulk demote, so it now
    // takes this same non-destructive update. A later episode toggle's
    // recomputeProgress re-derives the natural status from the surviving rows,
    // identical to how a single demoted title behaves.
    await prisma.title.updateMany({
      where: { id: { in: ids }, userId },
      data: { status },
    });
  }

  revalidateAll();
  return { count: owned.length };
}

export async function bulkSetFavorite(ids: string[], favorite: boolean) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkFavoriteSchema.safeParse({ ids, favorite });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  const res = await prisma.title.updateMany({
    where: { id: { in: ids }, userId },
    data: { favorite },
  });
  revalidateAll();
  return { count: res.count };
}

export async function bulkAddTag(ids: string[], tagName: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkTagSchema.safeParse({ ids, tagName });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  const name = normTagName(tagName);
  if (!name) return { error: "Tag name is required." };

  const owned = await ownedTitleIds(userId, ids);
  if (owned.length === 0) return { count: 0, tag: name };

  const tag = await findOrCreateTag(userId, name);
  await prisma.titleTag.createMany({
    data: owned.map((titleId) => ({ titleId, tagId: tag.id })),
    skipDuplicates: true,
  });
  revalidateAll();
  return { count: owned.length, tag: tag.name };
}

export async function bulkRemoveTag(ids: string[], tagName: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkTagSchema.safeParse({ ids, tagName });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  const name = normTagName(tagName);
  if (!name) return { error: "Tag name is required." };

  const owned = await ownedTitleIds(userId, ids);
  if (owned.length === 0) return { count: 0, tag: name };

  // Case-insensitive lookup (see findOrCreateTag) so removing "horror" still
  // finds a tag stored as "Horror" instead of silently no-op'ing.
  const tag = await prisma.tag.findFirst({
    where: { userId, name: tagNameFilter(name) },
    select: { id: true, name: true },
  });
  if (!tag) return { count: 0, tag: name };

  await prisma.titleTag.deleteMany({
    where: { titleId: { in: owned }, tagId: tag.id },
  });
  revalidateAll();
  return { count: owned.length, tag: tag.name };
}

export async function bulkRemoveTitles(ids: string[]) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkIdsSchema.safeParse({ ids });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  // Soft delete: move the selection to Trash (see removeTitle). Only rows not
  // already trashed are stamped, so the returned count reflects titles actually
  // moved and any earlier deletion dates are left untouched.
  const res = await prisma.title.updateMany({
    where: { id: { in: ids }, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  revalidateAll();
  return { count: res.count };
}

/**
 * Undo a bulk remove in one call (VE-01). Replaying restoreTitle per title
 * cost one POST each, which Next runs one at a time, each re-rendering the
 * library into its response. Same predicate as restoreTitle: only the owner's
 * rows still in Trash, so a title already restored elsewhere is left alone.
 */
export async function bulkRestoreTitles(ids: string[]) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = bulkIdsSchema.safeParse({ ids });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  ids = dedupeIds(parsed.data.ids);
  const limitError = bulkLimitError(ids);
  if (limitError) return { error: limitError };
  const res = await prisma.title.updateMany({
    where: { id: { in: ids }, userId, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  revalidateAll();
  return { count: res.count };
}

// --- Tags ------------------------------------------------------------------

export async function createTag(name: string, color?: string | null) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = createTagSchema.safeParse({ name, color });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const trimmed = normTagName(name);
  if (!trimmed) return { error: "Tag name is required." };
  const tag = await findOrCreateTag(userId, trimmed, color ?? null);
  revalidateAll();
  return { id: tag.id };
}

export async function toggleTitleTag(titleId: string, tagId: string, on: boolean) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = toggleTitleTagSchema.safeParse({ titleId, tagId, on });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const [title, tag] = await Promise.all([
    prisma.title.findFirst({ where: { id: titleId, userId }, select: { id: true } }),
    prisma.tag.findFirst({ where: { id: tagId, userId }, select: { id: true } }),
  ]);
  if (!title || !tag) return { error: "Title or tag not found." };

  if (on) {
    await prisma.titleTag.upsert({
      where: { titleId_tagId: { titleId, tagId } },
      create: { titleId, tagId },
      update: {},
    });
  } else {
    await prisma.titleTag.deleteMany({ where: { titleId, tagId } });
  }
  revalidateAll();
  return {};
}

/**
 * Rename a tag in place, keeping every title it is attached to.
 *
 * Tags could be created and deleted but never renamed, so a typo — or a
 * vocabulary that drifted from "rewatch" to "rewatchable" — could only be fixed
 * by deleting the tag (losing every attachment) and re-tagging by hand.
 *
 * Identity is case-insensitive (see findOrCreateTag), so the clash check has to
 * be too: without it, renaming "horror" to "Thriller" while a "thriller" exists
 * would trip the invisible functional index and surface a raw P2002. The
 * pre-check gives the owner a sentence they can act on; the P2002 catch covers
 * the window between the check and the update, exactly as findOrCreateTag does.
 * The tag's own row is excluded from the check so a case-only rename
 * ("horror" -> "Horror") is allowed rather than reported as a clash with itself.
 */
export async function renameTag(
  tagId: string,
  name: string,
): Promise<{ name?: string; error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = renameTagSchema.safeParse({ tagId, name });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const next = normTagName(parsed.data.name);
  if (!next) return { error: "Tag name is required." };

  const tag = await prisma.tag.findFirst({
    where: { id: parsed.data.tagId, userId },
    select: { id: true, name: true },
  });
  if (!tag) return { error: "Tag not found." };
  if (tag.name === next) return { name: tag.name };

  const taken = await prisma.tag.findFirst({
    where: {
      userId,
      id: { not: tag.id },
      name: tagNameFilter(next),
    },
    select: { name: true },
  });
  if (taken) return { error: `You already have a tag called “${taken.name}”.` };

  try {
    await prisma.tag.update({ where: { id: tag.id }, data: { name: next } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { error: `You already have a tag called “${next}”.` };
    }
    throw err;
  }
  revalidateAll();
  return { name: next };
}

/** Set (or clear, with null) a tag's colour. Palette values only — see tag-colors.ts. */
export async function setTagColor(
  tagId: string,
  color: string | null,
): Promise<{ error?: string }> {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = tagColorSchema.safeParse({ tagId, color });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const updated = await prisma.tag.updateMany({
    where: { id: parsed.data.tagId, userId },
    data: { color: parsed.data.color },
  });
  if (updated.count === 0) return { error: "Tag not found." };
  revalidateAll();
  return {};
}

export async function deleteTag(tagId: string) {
  const userId = await getUserId();
  if (!userId) return { error: SIGNED_OUT_MESSAGE };
  const parsed = tagIdArgSchema.safeParse({ tagId });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  await prisma.tag.deleteMany({ where: { id: tagId, userId } });
  revalidateAll();
  return {};
}
