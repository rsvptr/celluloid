"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
// Prisma is imported as a value (not `type`) alongside the enums: we reference
// Prisma.PrismaClientKnownRequestError at runtime to catch the addFromTmdb
// unique-constraint race. Its namespace also provides the types used below.
import {
  MediaType,
  WatchStatus,
  WatchEventKind,
  WatchEventSource,
  Prisma,
} from "@/generated/prisma/client";
import { getMovie, getSeason, getTv } from "@/lib/tmdb";
import { mapLimit } from "@/lib/async";
import { z } from "zod";

// --- Runtime validation (SEC-04) -------------------------------------------
// Every exported function here is a server action: a public HTTP endpoint that
// can be invoked with arbitrary arguments. TypeScript types are erased at
// runtime and validate nothing, so each action safeParses its arguments before
// any database or network work (immediately after the session check, which is
// left where it is). Failures surface through each action's existing contract —
// a thrown Error for the void / id-returning actions, a `{ error }` object for
// addFromTmdb and rematchTitle.

/**
 * Hard ceiling on ids processed per bulk call, after dedup. This is a
 * resource/DoS guard, not a UX limit — the owner legitimately runs bulk ops
 * over more than a couple hundred titles, so exceeding it is a rejected
 * request (see dedupeIds' callers), never a silent truncation that would
 * quietly drop titles the user selected and expected to be affected.
 */
const MAX_BULK_IDS = 1000;

/** Error message returned/thrown when a deduped id list exceeds MAX_BULK_IDS. */
const TOO_MANY_IDS_MESSAGE = `Too many titles selected (max ${MAX_BULK_IDS}).`;

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
const episodeToggleSchema = z.object({ episodeId: idSchema, watched: z.boolean() });
const seasonToggleSchema = z.object({ seasonId: idSchema, watched: z.boolean() });
const allEpisodesSchema = z.object({ titleId: idSchema, watched: z.boolean() });
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

/** Dedupe an id list. Does not truncate — callers must reject oversized lists
 * outright (via requireWithinBulkLimit) rather than silently drop ids. */
function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Throws when a deduped id list exceeds MAX_BULK_IDS. Call this after
 * dedupeIds and before any DB work so an oversized selection does nothing
 * (no partial apply) instead of silently processing only the first slice.
 */
function requireWithinBulkLimit(ids: string[]): void {
  if (ids.length > MAX_BULK_IDS) throw new Error(TOO_MANY_IDS_MESSAGE);
}

async function getUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user) throw new Error("You're signed out. Sign in and try again.");
  return session.user.id;
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00.000Z` : iso);
  return Number.isNaN(d.getTime()) ? null : d;
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
    where: { userId, name: { equals: name, mode: "insensitive" } },
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
        where: { userId, name: { equals: name, mode: "insensitive" } },
        select: { id: true, name: true },
      });
      if (race) return race;
    }
    throw err;
  }
}

function revalidateAll(id?: string) {
  revalidatePath("/");
  revalidatePath("/stats");
  revalidatePath("/export");
  if (id) revalidatePath(`/title/${id}`);
}

/** Recompute denormalized episode progress + natural status for a TV title. */
async function recomputeProgress(titleId: string) {
  // Lock the title row before counting: two rapid episode toggles otherwise
  // interleave (both count, then the stale write lands last). With the lock,
  // the second recompute waits and recounts AFTER the first one committed.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: WatchStatus; watchedAt: Date | null }[]>`
      SELECT status, "watchedAt" FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
    const title = rows[0];
    if (!title) return; // title removed concurrently; nothing to reconcile

    const total = await tx.episode.count({ where: { season: { titleId } } });
    const watched = await tx.episode.count({
      where: { season: { titleId }, watched: true },
    });

    let status = title.status;
    // Don't override deliberate ON_HOLD / DROPPED choices.
    if (status !== WatchStatus.ON_HOLD && status !== WatchStatus.DROPPED) {
      if (watched === 0) status = WatchStatus.WATCHLIST;
      else if (total > 0 && watched >= total) status = WatchStatus.WATCHED;
      else status = WatchStatus.WATCHING;
    }

    const data: { watchedEpisodes: number; status: WatchStatus; watchedAt?: Date } = {
      watchedEpisodes: watched,
      status,
    };
    // Stamp a completion date when a show finishes via the episode tracker
    // (mirrors the movie auto-stamp and bulkSetStatus) so episode-by-episode
    // completed TV feeds the recency signal. Only when not already dated.
    if (status === WatchStatus.WATCHED && title.watchedAt == null) {
      data.watchedAt = new Date();
    }

    await tx.title.update({ where: { id: titleId }, data });
  });
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
  // Server actions are network-callable with arbitrary args. Validate the whole
  // payload up front (unknown status, non-finite/oversized rating, oversized
  // notes, non-date watchedAt) so bad input is a clear error, not a Prisma 500.
  const parsed = updateTitleArgsSchema.safeParse({ id, data });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const input = parsed.data.data;

  const title = await prisma.title.findFirst({
    where: { id, userId },
    select: { id: true, status: true, watchedAt: true, totalEpisodes: true },
  });
  if (!title) throw new Error("Title not found.");

  const now = new Date();

  // A transition INTO watched with no explicit caller date stamps the completion
  // as now so it feeds stats activity/streaks and the AI recency signal, and so
  // the watchedAt cache advances forward. Keying on the status transition — not
  // on watchedAt being null — is what fixes the re-promotion bug: a title watched,
  // demoted, then re-marked WATCHED used to keep its stale pre-demote date (and
  // log a completion dated to it) because the old null-guard saw a non-null date
  // and skipped the stamp. An explicit caller date still wins (handled below).
  // Applies to TV too: marking a show WATCHED from its status select is as
  // deliberate a completion as ticking the last episode.
  const autoWatchedAt =
    input.watchedAt === undefined &&
    input.status === WatchStatus.WATCHED &&
    title.status !== WatchStatus.WATCHED
      ? now
      : undefined;

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

  const updateData: Prisma.TitleUpdateInput = {
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...ratingUpdate,
    ...(input.notes !== undefined
      ? { notes: input.notes == null ? null : input.notes.slice(0, 2000) }
      : {}),
    ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
    ...(input.watchedAt !== undefined ? { watchedAt: toDate(input.watchedAt) } : {}),
    ...(autoWatchedAt ? { watchedAt: autoWatchedAt } : {}),
  };

  // D-F2: keep the append-only WatchEvent log in step with the Title cache. The
  // effective watchedAt the row will hold after this write drives the event's
  // occurredAt, so the log and the cache never drift.
  const newWatchedAt: Date | null =
    input.watchedAt !== undefined
      ? toDate(input.watchedAt)
      : (autoWatchedAt ?? title.watchedAt);
  // A move INTO watched from any other state is a completion -> log one
  // TITLE_COMPLETED. Editing the date on an already-watched title instead
  // re-dates its latest completion/rewatch event to match the cache (never a
  // second completion). Mutually exclusive on title.status.
  const logsCompletion =
    input.status === WatchStatus.WATCHED && title.status !== WatchStatus.WATCHED;
  const redatesCompletion =
    input.watchedAt !== undefined &&
    title.status === WatchStatus.WATCHED &&
    newWatchedAt != null;

  // Event writes, run inside whichever Title-locked transaction path applies so
  // the Title row and its events commit as one unit.
  const writeEvents = async (tx: Prisma.TransactionClient) => {
    if (logsCompletion) {
      await tx.watchEvent.create({
        data: {
          userId,
          titleId: id,
          kind: WatchEventKind.TITLE_COMPLETED,
          occurredAt: newWatchedAt ?? now,
          source: WatchEventSource.MANUAL,
        },
      });
    } else if (redatesCompletion) {
      const latest = await tx.watchEvent.findFirst({
        where: {
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
      }
    }
  };

  // Completing a TV title from its status select must also settle the episode
  // tracker, exactly like bulkSetStatus's WATCHED branch: lock the Title row
  // FIRST with the same SELECT..FOR UPDATE the siblings take, then mark every
  // episode watched and sync watchedEpisodes to the total. Taking the Title lock
  // before touching episodes keeps the order Title-then-Episode, matching
  // recomputeProgress and both bulkSetStatus branches, so this can't deadlock
  // against a concurrent bulkSetStatus over the same title and a concurrent
  // episode toggle's recompute can't interleave and clobber watchedEpisodes.
  // Writing only `status` here would leave watchedEpisodes stale, so the next
  // episode toggle recomputes from a wrong base and silently demotes the show
  // back to WATCHING. Movies and episodeless titles keep the plain single-row
  // update. The multi-step write is wrapped in a transaction so the episode rows
  // and the counter can't diverge on partial failure.
  if (input.status === WatchStatus.WATCHED && (title.totalEpisodes ?? 0) > 0) {
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Title" WHERE id = ${id} FOR UPDATE`;
      if (!rows[0]) return; // title removed concurrently
      await tx.episode.updateMany({
        where: { season: { titleId: id }, watched: false },
        data: { watched: true, watchedAt: autoWatchedAt ?? now },
      });
      // Count fresh inside the lock — exact parity with bulkSetStatus's WATCHED
      // branch — instead of trusting the pre-transaction denormalized read.
      const total = await tx.episode.count({ where: { season: { titleId: id } } });
      await tx.title.update({
        where: { id },
        data: { ...updateData, watchedEpisodes: total },
      });
      await writeEvents(tx);
    });
  } else if (logsCompletion || redatesCompletion) {
    // Movie / episodeless completion, or a date edit on an already-watched
    // title: still lock the Title first (invariant) so the title update and the
    // event write commit atomically and can't interleave with a concurrent
    // logWatch on the same title.
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Title" WHERE id = ${id} FOR UPDATE`;
      if (!rows[0]) return; // title removed concurrently
      await tx.title.update({ where: { id }, data: updateData });
      await writeEvents(tx);
    });
  } else {
    await prisma.title.update({ where: { id }, data: updateData });
  }
  revalidateAll(id);
}

/**
 * D-F2: record an explicit viewing. Logs a REWATCH when the title is already
 * WATCHED, otherwise a TITLE_COMPLETED, promotes the title to WATCHED, and moves
 * the watchedAt cache forward to max(existing, occurredAt) so a back-dated log
 * never rewinds a later completion. Title-FOR-UPDATE-first so the event, the
 * status/date cache and the returned count are one consistent unit. Returns the
 * fresh completion+rewatch count for the "Watched n times" toast.
 */
export async function logWatch(
  titleId: string,
  input: { occurredAt: string; note?: string | null },
): Promise<{ ok?: boolean; watchCount?: number; error?: string }> {
  const userId = await getUserId();
  const parsed = logWatchSchema.safeParse({
    titleId,
    occurredAt: input.occurredAt,
    note: input.note,
  });
  if (!parsed.success) return { error: "Invalid request. Refresh and try again." };
  const occurred = toDate(parsed.data.occurredAt);
  if (!occurred) return { error: "Invalid request. Refresh and try again." };
  const trimmed = parsed.data.note?.trim();
  const note = trimmed ? trimmed.slice(0, 500) : null;

  const result = await prisma.$transaction(async (tx) => {
    // Lock + authorize in one shot: the FOR UPDATE row is both the lock and the
    // ownership check. Siblings (updateTitle / episode marks) lock Title first too.
    const rows = await tx.$queryRaw<
      { status: WatchStatus; watchedAt: Date | null }[]
    >`SELECT status, "watchedAt" FROM "Title" WHERE id = ${titleId} AND "userId" = ${userId} FOR UPDATE`;
    const row = rows[0];
    if (!row) return null; // not found or not owned

    const kind =
      row.status === WatchStatus.WATCHED
        ? WatchEventKind.REWATCH
        : WatchEventKind.TITLE_COMPLETED;
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

    const watchCount = await tx.watchEvent.count({
      where: {
        titleId,
        kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
      },
    });
    return { watchCount };
  });

  if (!result) return { error: "Title not found." };
  revalidateAll(titleId);
  return { ok: true, watchCount: result.watchCount };
}

export async function removeTitle(id: string) {
  const userId = await getUserId();
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
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
  revalidateAll(id);
}

export async function restoreTitle(id: string) {
  const userId = await getUserId();
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  // Clear the soft-delete flag. Nothing else was touched on delete, so the title
  // returns exactly as it was. Scoped to already-trashed rows (and the user) so a
  // stray call can't perturb a live title.
  await prisma.title.updateMany({
    where: { id, userId, deletedAt: { not: null } },
    data: { deletedAt: null },
  });
  revalidateAll(id);
}

export async function purgeTitle(id: string) {
  const userId = await getUserId();
  const parsed = idArgSchema.safeParse({ id });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  // Permanent delete. Season/Episode/WatchEvent/TitleTag/ShareListItem rows cascade
  // (onDelete: Cascade); ImportItem.titleId is set null. Restricted to rows already
  // in Trash so the only route to a hard delete is remove-then-purge — a live title
  // can never be destroyed in one step, and a purge racing a concurrent restore
  // safely no-ops rather than nuking the just-restored title.
  await prisma.title.deleteMany({ where: { id, userId, deletedAt: { not: null } } });
  revalidateAll();
}

// --- Episode / season tracking ---------------------------------------------

export async function setEpisodeWatched(episodeId: string, watched: boolean) {
  const userId = await getUserId();
  const parsed = episodeToggleSchema.safeParse({ episodeId, watched });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const ep = await prisma.episode.findFirst({
    where: { id: episodeId, season: { title: { userId } } },
    select: { id: true, season: { select: { titleId: true } } },
  });
  if (!ep) throw new Error("Episode not found.");
  const titleId = ep.season.titleId;

  // Flip the episode flag and its WatchEvent together, under a Title lock taken
  // first (invariant) so this serializes against the season / all / bulk marks
  // and can't race their snapshot-then-update. recomputeProgress then reconciles
  // the denormalized counter and natural status.
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
    if (!rows[0]) return; // title removed concurrently
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
      // Toggling off removes only the most recent auto-logged (MANUAL/BULK),
      // un-noted episode-watched event. Noted and REWATCH history are preserved.
      const latest = await tx.watchEvent.findFirst({
        where: {
          episodeId,
          kind: WatchEventKind.EPISODE_WATCHED,
          source: { in: [WatchEventSource.MANUAL, WatchEventSource.BULK] },
          note: null,
        },
        orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (latest) await tx.watchEvent.delete({ where: { id: latest.id } });
    }
  });
  await recomputeProgress(titleId);
  revalidateAll(titleId);
}

export async function setSeasonWatched(seasonId: string, watched: boolean) {
  const userId = await getUserId();
  const parsed = seasonToggleSchema.safeParse({ seasonId, watched });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const season = await prisma.season.findFirst({
    where: { id: seasonId, title: { userId } },
    select: { titleId: true },
  });
  if (!season) throw new Error("Season not found.");
  const titleId = season.titleId;

  if (watched) {
    // Stamp only the episodes that weren't already watched (preserving real
    // dates) and log one BULK EPISODE_WATCHED event each. The Title lock is taken
    // first (invariant) so the id snapshot, the flag write and the event
    // createMany are one atomic, race-free unit.
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
      if (!rows[0]) return; // title removed concurrently
      const now = new Date();
      const toWatch = await tx.episode.findMany({
        where: { seasonId, watched: false },
        select: { id: true },
      });
      if (toWatch.length) {
        await tx.episode.updateMany({
          where: { seasonId, watched: false },
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
    });
  } else {
    // Demotion preserves event history by design: clear the flags only.
    await prisma.episode.updateMany({
      where: { seasonId },
      data: { watched: false, watchedAt: null },
    });
  }
  await recomputeProgress(titleId);
  revalidateAll(titleId);
}

export async function setAllEpisodesWatched(titleId: string, watched: boolean) {
  const userId = await getUserId();
  const parsed = allEpisodesSchema.safeParse({ titleId, watched });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const title = await prisma.title.findFirst({
    where: { id: titleId, userId },
    select: { id: true },
  });
  if (!title) throw new Error("Title not found.");

  if (watched) {
    // Mark every unwatched episode and log one BULK EPISODE_WATCHED event each,
    // under a Title-first lock (invariant) so the snapshot -> update -> event
    // sequence is atomic and race-free (see setSeasonWatched).
    await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
      if (!rows[0]) return; // title removed concurrently
      const now = new Date();
      const toWatch = await tx.episode.findMany({
        where: { season: { titleId }, watched: false },
        select: { id: true },
      });
      if (toWatch.length) {
        await tx.episode.updateMany({
          where: { season: { titleId }, watched: false },
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
    });
  } else {
    // Demotion preserves event history by design: clear the flags only.
    await prisma.episode.updateMany({
      where: { season: { titleId } },
      data: { watched: false, watchedAt: null },
    });
  }
  await recomputeProgress(titleId);
  revalidateAll(titleId);
}

type FetchedSeason = { n: number; sd: Awaited<ReturnType<typeof getSeason>> };

/**
 * Fetches all season details for a TV title from TMDB (network only, no DB
 * writes). `allOk` is false if any listed season failed to load — callers that
 * destroy existing data (re-match) should abort when `allOk` is false so a
 * transient TMDB failure can never wipe a user's progress.
 */
async function fetchSeasonData(
  tvTmdbId: number,
  tv: Awaited<ReturnType<typeof getTv>>,
): Promise<{ seasons: FetchedSeason[]; allOk: boolean }> {
  const seasonNumbers = tv.seasons
    .map((s) => s.season_number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);

  // Season fetches are independent — run them concurrently (bounded, so a
  // 40-season soap doesn't burst-fire at TMDB) instead of one at a time.
  const fetched = await mapLimit(seasonNumbers, 6, async (n) => ({
    n,
    sd: await getSeason(tvTmdbId, n).catch(() => null),
  }));
  const seasons = fetched.filter((f): f is FetchedSeason => f.sd !== null);
  return { seasons, allOk: seasons.length === seasonNumbers.length };
}

/**
 * Writes Season + Episode rows from pre-fetched TMDB data inside a transaction.
 * When `prior` is given (keyed "season:episode"), preserves watched state/date
 * AND the original discoveredAt for episodes that still exist so a refresh/
 * re-match keeps progress and doesn't reset episode discovery (which would
 * spuriously re-fire the "New episodes" badge). Genuinely new rows fall back to
 * the schema's discoveredAt default of now().
 */
async function writeSeasons(
  tx: Prisma.TransactionClient,
  titleId: string,
  seasons: FetchedSeason[],
  prior?: Map<string, { watched: boolean; watchedAt: Date | null; discoveredAt: Date }>,
): Promise<void> {
  for (const { n, sd } of seasons) {
    const season = await tx.season.create({
      data: {
        titleId,
        tmdbId: sd.id,
        seasonNumber: n,
        name: sd.name || null,
        overview: sd.overview || null,
        airDate: toDate(sd.air_date),
        posterPath: sd.poster_path,
        episodeCount: sd.episodes?.length ?? null,
      },
    });
    if (sd.episodes?.length) {
      await tx.episode.createMany({
        data: sd.episodes.map((ep) => {
          const p = prior?.get(`${n}:${ep.episode_number}`);
          return {
            seasonId: season.id,
            tmdbId: ep.id,
            episodeNumber: ep.episode_number,
            name: ep.name || null,
            overview: ep.overview || null,
            airDate: toDate(ep.air_date),
            runtime: ep.runtime ?? null,
            stillPath: ep.still_path,
            watched: p?.watched ?? false,
            watchedAt: p?.watched ? (p.watchedAt ?? null) : null,
            // Carry the prior discoveredAt for episodes that already existed so a
            // refresh/re-match doesn't reset discovery; new rows omit it and take
            // the schema default (now()).
            ...(p ? { discoveredAt: p.discoveredAt } : {}),
          };
        }),
      });
    }
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
      revalidateAll(dup.id);
      return { id: dup.id, restored: true };
    }
    return { id: dup.id, existing: true };
  }

  try {
    if (mt === MediaType.MOVIE) {
      const m = await getMovie(tmdbId);
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

    const tv = await getTv(tmdbId);
    // Fetch all season data before any DB writes, then persist atomically. Unlike
    // re-match (which aborts on partial data to protect existing progress), a
    // fresh add has nothing to lose: on a partial TMDB failure we still create the
    // title from the seasons that DID load and return a warning so the user can
    // refresh later. The denormalized counts below are reconciled from the rows
    // actually stored, so they never claim more seasons/episodes than were saved.
    const { seasons, allOk } = await fetchSeasonData(tmdbId, tv);
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
            status: WatchStatus.WATCHLIST,
            source: "tmdb",
          },
        });
        await writeSeasons(tx, t.id, seasons);
        // totalEpisodes from the rows we actually created.
        const epTotal = await tx.episode.count({
          where: { season: { titleId: t.id } },
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
          revalidateAll(existing.id);
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
 * Re-links a title to a (possibly different) TMDB entry and refreshes its
 * metadata, preserving personal tracking (status/rating/notes/favorite/tags) and
 * — for TV — watched progress by (season, episode) number. Also used to refresh
 * metadata in place by passing the title's current tmdbId.
 */
export async function rematchTitle(
  titleId: string,
  tmdbId: number,
  mediaType: "movie" | "tv",
): Promise<{ ok?: boolean; error?: string; existingId?: string }> {
  const userId = await getUserId();
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
      const m = await getMovie(tmdbId);
      const found = await prisma.$transaction(async (tx) => {
        // Lock the Title row FIRST so locks are taken Title-then-Episode, the
        // same order every other transaction in this file uses. season.deleteMany
        // cascades onto Episode (onDelete: Cascade), so running it before the
        // Title lock would lock Episode rows first and invert the order against a
        // concurrent recompute / bulkSetStatus, risking a deadlock.
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
        if (!rows[0]) return false; // title removed concurrently
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
            source: "tmdb",
          },
        });
        return true;
      });
      if (!found) return { error: "Title not found." };
    } else {
      const tv = await getTv(tmdbId);
      // Fetch ALL season data before touching the DB. If any season failed to
      // load, abort without deleting anything (never destroy progress on a
      // transient TMDB failure).
      const { seasons, allOk } = await fetchSeasonData(tmdbId, tv);
      if (!allOk) {
        return {
          error:
            "Couldn't load all season data from TMDB. Nothing was changed, please try again.",
        };
      }

      // Snapshot prior watched state and discovery time so a refresh/re-match
      // keeps progress and doesn't reset episode discovery — the "New episodes"
      // badge keys on discoveredAt, so re-materializing rows with a fresh now()
      // would make every refreshed show look like it just gained episodes.
      const prevEps = await prisma.episode.findMany({
        where: { season: { titleId } },
        select: {
          episodeNumber: true,
          watched: true,
          watchedAt: true,
          discoveredAt: true,
          season: { select: { seasonNumber: true } },
        },
      });
      const prior = new Map<
        string,
        { watched: boolean; watchedAt: Date | null; discoveredAt: Date }
      >();
      for (const e of prevEps) {
        prior.set(`${e.season.seasonNumber}:${e.episodeNumber}`, {
          watched: e.watched,
          watchedAt: e.watchedAt,
          discoveredAt: e.discoveredAt,
        });
      }

      const found = await prisma.$transaction(
        async (tx) => {
          // Lock the Title row FIRST so locks are taken Title-then-Episode, the
          // same order every other transaction in this file uses. season.deleteMany
          // cascades onto Episode (onDelete: Cascade), so running it before the
          // Title lock would lock Episode rows first and invert the order against
          // a concurrent recompute / bulkSetStatus, risking a deadlock.
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
          if (!rows[0]) return false; // title removed concurrently
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
              runtime: tv.episode_run_time?.[0] ?? null,
              genres: tv.genres?.map((g) => g.name) ?? [],
              totalSeasons: tv.number_of_seasons ?? null,
              source: "tmdb",
            },
          });
          await writeSeasons(tx, titleId, seasons, prior);
          const epTotal = await tx.episode.count({
            where: { season: { titleId } },
          });
          const epWatched = await tx.episode.count({
            where: { season: { titleId }, watched: true },
          });
          // Update counts but preserve the user's chosen status (manual override).
          await tx.title.update({
            where: { id: titleId },
            data: { totalEpisodes: epTotal, watchedEpisodes: epWatched },
          });
          return true;
        },
        { timeout: 20000 },
      );
      if (!found) return { error: "Title not found." };
    }

    revalidateAll(titleId);
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
  const parsed = bulkStatusSchema.safeParse({ ids, status });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  ids = dedupeIds(parsed.data.ids);
  requireWithinBulkLimit(ids);
  const owned = await prisma.title.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, mediaType: true, status: true, watchedAt: true },
  });
  const movieIds = owned.filter((t) => t.mediaType === MediaType.MOVIE).map((t) => t.id);
  const tvIds = owned.filter((t) => t.mediaType === MediaType.TV).map((t) => t.id);
  // Only titles genuinely moving INTO watched get a completion event and a
  // forward-advanced watchedAt; those already WATCHED are re-affirmed without
  // inflating their watch count or disturbing their real completion date.
  const newlyWatched = owned.filter((t) => t.status !== WatchStatus.WATCHED);
  const newlyWatchedIds = new Set(newlyWatched.map((t) => t.id));
  const now = new Date();

  if (status === WatchStatus.WATCHED) {
    if (movieIds.length) {
      // A genuine transition into WATCHED advances the completion date to now, so
      // re-promoting a movie after a demote can't keep its stale pre-demote date;
      // movies already WATCHED keep their real date via a status-only re-affirm.
      // Keying on the transition — not on watchedAt being null — is the fix.
      const promotedMovieIds = movieIds.filter((id) => newlyWatchedIds.has(id));
      const affirmedMovieIds = movieIds.filter((id) => !newlyWatchedIds.has(id));
      if (promotedMovieIds.length) {
        await prisma.title.updateMany({
          where: { id: { in: promotedMovieIds }, userId },
          data: { status, watchedAt: now },
        });
      }
      if (affirmedMovieIds.length) {
        await prisma.title.updateMany({
          where: { id: { in: affirmedMovieIds }, userId },
          data: { status },
        });
      }
    }
    if (tvIds.length) {
      // Reconcile each show inside its own transaction that first takes the same
      // SELECT..FOR UPDATE lock recomputeProgress uses. The old path issued the
      // episode mark, grouped count, per-title updates and completion stamp as
      // independent un-transacted writes: a partial failure could leave the
      // counter out of step with the episode rows, and none of them held the
      // row lock, so a concurrent episode toggle's recompute could interleave.
      // Bounded concurrency keeps a large multi-select from exhausting the pool.
      await mapLimit(tvIds, 6, (titleId) =>
        prisma.$transaction(async (tx) => {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM "Title" WHERE id = ${titleId} FOR UPDATE`;
          if (!rows[0]) return; // title removed concurrently; nothing to reconcile
          await tx.episode.updateMany({
            where: { season: { titleId }, watched: false },
            data: { watched: true, watchedAt: now },
          });
          const total = await tx.episode.count({ where: { season: { titleId } } });
          const data: {
            status: WatchStatus;
            watchedEpisodes: number;
            watchedAt?: Date;
          } = { status, watchedEpisodes: total };
          // Advance the completion date to now on a genuine transition into
          // WATCHED (a title already WATCHED keeps its real date), and only where
          // episodes exist so an episodeless unmatched import can't fabricate
          // activity — mirroring the movie branch above.
          if (total > 0 && newlyWatchedIds.has(titleId)) data.watchedAt = now;
          await tx.title.update({ where: { id: titleId }, data });
        }),
      );
    }
    // One BULK TITLE_COMPLETED per genuinely-completed title (createMany for
    // efficiency), mirroring updateTitle's single-completion semantics. These are
    // all transitions into WATCHED with no caller-supplied date, so occurredAt is
    // now — matching the watchedAt the branches above just advanced to, never a
    // stale pre-demote date.
    if (newlyWatched.length) {
      await prisma.watchEvent.createMany({
        data: newlyWatched.map((t) => ({
          userId,
          titleId: t.id,
          kind: WatchEventKind.TITLE_COMPLETED,
          occurredAt: now,
          source: WatchEventSource.BULK,
        })),
      });
    }
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
  const parsed = bulkFavoriteSchema.safeParse({ ids, favorite });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  ids = dedupeIds(parsed.data.ids);
  requireWithinBulkLimit(ids);
  const res = await prisma.title.updateMany({
    where: { id: { in: ids }, userId },
    data: { favorite },
  });
  revalidateAll();
  return { count: res.count };
}

export async function bulkAddTag(ids: string[], tagName: string) {
  const userId = await getUserId();
  const parsed = bulkTagSchema.safeParse({ ids, tagName });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  ids = dedupeIds(parsed.data.ids);
  requireWithinBulkLimit(ids);
  const name = normTagName(tagName);
  if (!name) throw new Error("Tag name is required.");

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
  const parsed = bulkTagSchema.safeParse({ ids, tagName });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  ids = dedupeIds(parsed.data.ids);
  requireWithinBulkLimit(ids);
  const name = normTagName(tagName);
  if (!name) throw new Error("Tag name is required.");

  const owned = await ownedTitleIds(userId, ids);
  if (owned.length === 0) return { count: 0, tag: name };

  // Case-insensitive lookup (see findOrCreateTag) so removing "horror" still
  // finds a tag stored as "Horror" instead of silently no-op'ing.
  const tag = await prisma.tag.findFirst({
    where: { userId, name: { equals: name, mode: "insensitive" } },
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
  const parsed = bulkIdsSchema.safeParse({ ids });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  ids = dedupeIds(parsed.data.ids);
  requireWithinBulkLimit(ids);
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

// --- Tags ------------------------------------------------------------------

export async function createTag(name: string, color?: string | null) {
  const userId = await getUserId();
  const parsed = createTagSchema.safeParse({ name, color });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const trimmed = normTagName(name);
  if (!trimmed) throw new Error("Tag name is required.");
  const tag = await findOrCreateTag(userId, trimmed, color ?? null);
  revalidateAll();
  return tag.id;
}

export async function toggleTitleTag(titleId: string, tagId: string, on: boolean) {
  const userId = await getUserId();
  const parsed = toggleTitleTagSchema.safeParse({ titleId, tagId, on });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  const [title, tag] = await Promise.all([
    prisma.title.findFirst({ where: { id: titleId, userId }, select: { id: true } }),
    prisma.tag.findFirst({ where: { id: tagId, userId }, select: { id: true } }),
  ]);
  if (!title || !tag) throw new Error("Title or tag not found.");

  if (on) {
    await prisma.titleTag.upsert({
      where: { titleId_tagId: { titleId, tagId } },
      create: { titleId, tagId },
      update: {},
    });
  } else {
    await prisma.titleTag.deleteMany({ where: { titleId, tagId } });
  }
  revalidateAll(titleId);
}

export async function deleteTag(tagId: string) {
  const userId = await getUserId();
  const parsed = tagIdArgSchema.safeParse({ tagId });
  if (!parsed.success) throw new Error("Invalid request. Refresh and try again.");
  await prisma.tag.deleteMany({ where: { id: tagId, userId } });
  revalidateAll();
}
