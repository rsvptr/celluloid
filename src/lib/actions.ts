"use server";

import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { MediaType, WatchStatus } from "@/generated/prisma/client";
import type { Prisma } from "@/generated/prisma/client";
import { getMovie, getSeason, getTv } from "@/lib/tmdb";

async function getUserId(): Promise<string> {
  const session = await getSession();
  if (!session?.user) throw new Error("Unauthorized");
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
  // Server actions are network-callable with arbitrary args; reject an unknown
  // status here with a clear error instead of surfacing a Prisma 500.
  if (data.status !== undefined && !Object.values(WatchStatus).includes(data.status)) {
    throw new Error("Invalid status.");
  }
  const title = await prisma.title.findFirst({
    where: { id, userId },
    select: { id: true, mediaType: true, watchedAt: true },
  });
  if (!title) throw new Error("Not found");

  // When a movie is completed without an explicit date, stamp it so it feeds
  // the stats activity/streaks (only if not already dated).
  const autoWatchedAt =
    data.watchedAt === undefined &&
    data.status === WatchStatus.WATCHED &&
    title.mediaType === MediaType.MOVIE &&
    title.watchedAt == null
      ? new Date()
      : undefined;

  // Normalize the rating before it can reach the DB: reject non-finite numbers
  // (NaN would poison the stats averages), clamp to 0-10, and snap to the same
  // half-star steps the UI uses.
  const clampedRating =
    data.rating == null
      ? data.rating
      : Number.isFinite(data.rating)
        ? Math.round(Math.max(0, Math.min(10, data.rating)) * 2) / 2
        : undefined;

  await prisma.title.update({
    where: { id },
    data: {
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.rating !== undefined && clampedRating !== undefined
        ? { rating: clampedRating }
        : {}),
      ...(data.notes !== undefined
        ? { notes: data.notes == null ? null : data.notes.slice(0, 2000) }
        : {}),
      ...(data.favorite !== undefined ? { favorite: data.favorite } : {}),
      ...(data.watchedAt !== undefined ? { watchedAt: toDate(data.watchedAt) } : {}),
      ...(autoWatchedAt ? { watchedAt: autoWatchedAt } : {}),
    },
  });
  revalidateAll(id);
}

export async function removeTitle(id: string) {
  const userId = await getUserId();
  await prisma.title.deleteMany({ where: { id, userId } });
  revalidateAll();
}

// --- Episode / season tracking ---------------------------------------------

export async function setEpisodeWatched(episodeId: string, watched: boolean) {
  const userId = await getUserId();
  const ep = await prisma.episode.findFirst({
    where: { id: episodeId, season: { title: { userId } } },
    select: { id: true, season: { select: { titleId: true } } },
  });
  if (!ep) throw new Error("Not found");

  await prisma.episode.update({
    where: { id: episodeId },
    data: { watched, watchedAt: watched ? new Date() : null },
  });
  await recomputeProgress(ep.season.titleId);
  revalidateAll(ep.season.titleId);
}

export async function setSeasonWatched(seasonId: string, watched: boolean) {
  const userId = await getUserId();
  const season = await prisma.season.findFirst({
    where: { id: seasonId, title: { userId } },
    select: { titleId: true },
  });
  if (!season) throw new Error("Not found");

  if (watched) {
    // Only stamp episodes that weren't already watched, preserving real dates.
    await prisma.episode.updateMany({
      where: { seasonId, watched: false },
      data: { watched: true, watchedAt: new Date() },
    });
  } else {
    await prisma.episode.updateMany({
      where: { seasonId },
      data: { watched: false, watchedAt: null },
    });
  }
  await recomputeProgress(season.titleId);
  revalidateAll(season.titleId);
}

export async function setAllEpisodesWatched(titleId: string, watched: boolean) {
  const userId = await getUserId();
  const title = await prisma.title.findFirst({
    where: { id: titleId, userId },
    select: { id: true },
  });
  if (!title) throw new Error("Not found");

  if (watched) {
    await prisma.episode.updateMany({
      where: { season: { titleId }, watched: false },
      data: { watched: true, watchedAt: new Date() },
    });
  } else {
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

  const seasons: FetchedSeason[] = [];
  let allOk = true;
  for (const n of seasonNumbers) {
    const sd = await getSeason(tvTmdbId, n).catch(() => null);
    if (sd) seasons.push({ n, sd });
    else allOk = false;
  }
  return { seasons, allOk };
}

/**
 * Writes Season + Episode rows from pre-fetched TMDB data inside a transaction.
 * When `prior` is given (keyed "season:episode"), preserves watched state/date
 * for episodes that still exist so a refresh/re-match keeps progress.
 */
async function writeSeasons(
  tx: Prisma.TransactionClient,
  titleId: string,
  seasons: FetchedSeason[],
  prior?: Map<string, { watched: boolean; watchedAt: Date | null }>,
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
): Promise<{ id?: string; error?: string; existing?: boolean }> {
  const userId = await getUserId();
  const mt = mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;

  const dup = await prisma.title.findUnique({
    where: { userId_mediaType_tmdbId: { userId, mediaType: mt, tmdbId } },
    select: { id: true },
  });
  if (dup) return { id: dup.id, existing: true };

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
    // Fetch all season data before any DB writes, then persist atomically.
    const { seasons } = await fetchSeasonData(tmdbId, tv);
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
            totalSeasons: tv.number_of_seasons ?? null,
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
    return { id: created.id };
  } catch (err) {
    return { error: (err as Error).message };
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
  const current = await prisma.title.findFirst({
    where: { id: titleId, userId },
    select: { id: true },
  });
  if (!current) throw new Error("Not found");

  const mt = mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
  const clash = await prisma.title.findFirst({
    where: { userId, mediaType: mt, tmdbId, NOT: { id: titleId } },
    select: { id: true },
  });
  if (clash) {
    return { error: "That title is already in your library.", existingId: clash.id };
  }

  try {
    if (mt === MediaType.MOVIE) {
      const m = await getMovie(tmdbId);
      await prisma.$transaction(async (tx) => {
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
      });
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

      // Snapshot prior watched state so a refresh/re-match keeps progress.
      const prevEps = await prisma.episode.findMany({
        where: { season: { titleId } },
        select: {
          episodeNumber: true,
          watched: true,
          watchedAt: true,
          season: { select: { seasonNumber: true } },
        },
      });
      const prior = new Map<string, { watched: boolean; watchedAt: Date | null }>();
      for (const e of prevEps) {
        prior.set(`${e.season.seasonNumber}:${e.episodeNumber}`, {
          watched: e.watched,
          watchedAt: e.watchedAt,
        });
      }

      await prisma.$transaction(
        async (tx) => {
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
        },
        { timeout: 20000 },
      );
    }

    revalidateAll(titleId);
    return { ok: true };
  } catch (err) {
    return { error: (err as Error).message };
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
  if (!Object.values(WatchStatus).includes(status)) {
    throw new Error("Invalid status.");
  }
  const owned = await prisma.title.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true, mediaType: true },
  });
  const movieIds = owned.filter((t) => t.mediaType === MediaType.MOVIE).map((t) => t.id);
  const tvIds = owned.filter((t) => t.mediaType === MediaType.TV).map((t) => t.id);
  const now = new Date();

  if (status === WatchStatus.WATCHED) {
    if (movieIds.length) {
      // Stamp watchedAt only where it isn't already set (preserve real dates).
      await prisma.title.updateMany({
        where: { id: { in: movieIds }, userId, watchedAt: null },
        data: { status, watchedAt: now },
      });
      await prisma.title.updateMany({
        where: { id: { in: movieIds }, userId, watchedAt: { not: null } },
        data: { status },
      });
    }
    if (tvIds.length) {
      // Mark every episode watched, then reconcile each title's count + status.
      await prisma.episode.updateMany({
        where: { season: { titleId: { in: tvIds } }, watched: false },
        data: { watched: true, watchedAt: now },
      });
      for (const titleId of tvIds) {
        const c = await prisma.episode.count({ where: { season: { titleId } } });
        // For an episode-less TV title (e.g. unmatched import) don't fabricate a
        // watchedAt — that would pollute the activity heatmap/streaks.
        await prisma.title.update({
          where: { id: titleId },
          data:
            c > 0
              ? { status, watchedEpisodes: c, watchedAt: now }
              : { status, watchedEpisodes: 0 },
        });
      }
    }
  } else if (status === WatchStatus.WATCHLIST) {
    if (movieIds.length) {
      await prisma.title.updateMany({
        where: { id: { in: movieIds }, userId },
        data: { status },
      });
    }
    if (tvIds.length) {
      await prisma.episode.updateMany({
        where: { season: { titleId: { in: tvIds } } },
        data: { watched: false, watchedAt: null },
      });
      await prisma.title.updateMany({
        where: { id: { in: tvIds }, userId },
        data: { status, watchedEpisodes: 0 },
      });
    }
  } else {
    // WATCHING / ON_HOLD / DROPPED — set the enum, leave episode progress intact.
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
  const res = await prisma.title.updateMany({
    where: { id: { in: ids }, userId },
    data: { favorite },
  });
  revalidateAll();
  return { count: res.count };
}

export async function bulkAddTag(ids: string[], tagName: string) {
  const userId = await getUserId();
  const name = normTagName(tagName);
  if (!name) throw new Error("Tag name required");

  const owned = await ownedTitleIds(userId, ids);
  if (owned.length === 0) return { count: 0, tag: name };

  const tag = await prisma.tag.upsert({
    where: { userId_name: { userId, name } },
    create: { userId, name },
    update: {},
  });
  await prisma.titleTag.createMany({
    data: owned.map((titleId) => ({ titleId, tagId: tag.id })),
    skipDuplicates: true,
  });
  revalidateAll();
  return { count: owned.length, tag: name };
}

export async function bulkRemoveTag(ids: string[], tagName: string) {
  const userId = await getUserId();
  const name = normTagName(tagName);
  if (!name) throw new Error("Tag name required");

  const owned = await ownedTitleIds(userId, ids);
  if (owned.length === 0) return { count: 0, tag: name };

  const tag = await prisma.tag.findFirst({
    where: { userId, name },
    select: { id: true },
  });
  if (!tag) return { count: 0, tag: name };

  await prisma.titleTag.deleteMany({
    where: { titleId: { in: owned }, tagId: tag.id },
  });
  revalidateAll();
  return { count: owned.length, tag: name };
}

export async function bulkRemoveTitles(ids: string[]) {
  const userId = await getUserId();
  const res = await prisma.title.deleteMany({
    where: { id: { in: ids }, userId },
  });
  revalidateAll();
  return { count: res.count };
}

// --- Tags ------------------------------------------------------------------

export async function createTag(name: string, color?: string | null) {
  const userId = await getUserId();
  const trimmed = normTagName(name);
  if (!trimmed) throw new Error("Tag name required");
  const tag = await prisma.tag.upsert({
    where: { userId_name: { userId, name: trimmed } },
    create: { userId, name: trimmed, color: color ?? null },
    update: {},
  });
  revalidateAll();
  return tag.id;
}

export async function toggleTitleTag(titleId: string, tagId: string, on: boolean) {
  const userId = await getUserId();
  const [title, tag] = await Promise.all([
    prisma.title.findFirst({ where: { id: titleId, userId }, select: { id: true } }),
    prisma.tag.findFirst({ where: { id: tagId, userId }, select: { id: true } }),
  ]);
  if (!title || !tag) throw new Error("Not found");

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
  await prisma.tag.deleteMany({ where: { id: tagId, userId } });
  revalidateAll();
}
