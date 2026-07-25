import "server-only";
import { prisma } from "@/lib/prisma";
import { dayKeyInZone } from "@/lib/data";
import { MediaType, WatchStatus } from "@/generated/prisma/client";

/**
 * Reads for the airing-soon view. Kept beside the route rather than in
 * lib/data because nothing else consumes these shapes, and both queries lean on
 * columns (Title.nextEpisodeAirDate, Episode.airDate) that only the scheduled
 * metadata sync keeps current.
 */

/** How far ahead the schedule looks. Past this, a date is an announcement, not a plan. */
const HORIZON_DAYS = 60;

/** Ceiling on the "waiting for you" list so a long-neglected library stays readable. */
const WAITING_LIMIT = 40;

const DAY_MS = 86_400_000;

/** A tracked show with a dated next episode. */
export interface AiringSoonEntry {
  id: string;
  name: string;
  posterPath: string | null;
  status: WatchStatus;
  /** Air date as "YYYY-MM-DD" — the column is a calendar date, not an instant. */
  airDateKey: string;
  /** TMDB's lifecycle string, shown when it adds something ("Returning Series"). */
  tmdbStatus: string | null;
  totalEpisodes: number | null;
  watchedEpisodes: number;
}

/** A tracked show with episodes that have aired and are still unwatched. */
export interface WaitingEntry {
  id: string;
  name: string;
  posterPath: string | null;
  status: WatchStatus;
  /** Aired-but-unwatched episode count. */
  waiting: number;
  /** Air date of the most recent of them, as "YYYY-MM-DD". */
  latestAirDateKey: string;
  totalEpisodes: number | null;
  watchedEpisodes: number;
}

export interface UpcomingData {
  /** The owner's local today, as "YYYY-MM-DD" — the anchor for every label. */
  todayKey: string;
  /** Airing entries in date order, one group per calendar date. */
  groups: { dateKey: string; entries: AiringSoonEntry[] }[];
  waiting: WaitingEntry[];
  /** TV titles tracked at all, so an empty page can tell the two empties apart. */
  trackedShows: number;
  /** Most recent scheduled-sync stamp across the owner's TV titles, or null. */
  lastSyncedAt: string | null;
}

interface WaitingRow {
  id: string;
  name: string;
  posterPath: string | null;
  status: WatchStatus;
  totalEpisodes: number | null;
  watchedEpisodes: number;
  waiting: number;
  latestAirDate: Date;
}

/** A calendar-date column read back as "YYYY-MM-DD" (it is stored at UTC midnight). */
function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function getUpcoming(userId: string): Promise<UpcomingData> {
  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { timeZone: true },
  });
  // "Today" is the owner's today, not the server's: a show airing tonight in
  // Kochi must not read as yesterday because the function ran in UTC.
  const todayKey = dayKeyInZone(new Date(), owner?.timeZone || "UTC");
  const today = new Date(`${todayKey}T00:00:00.000Z`);
  const horizon = new Date(today.getTime() + HORIZON_DAYS * DAY_MS);

  const [airing, waitingRows, tracked] = await Promise.all([
    prisma.title.findMany({
      where: {
        userId,
        deletedAt: null,
        mediaType: MediaType.TV,
        // A dropped show's next episode is not news the owner asked for.
        status: { not: WatchStatus.DROPPED },
        nextEpisodeAirDate: { gte: today, lte: horizon },
      },
      orderBy: [{ nextEpisodeAirDate: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        posterPath: true,
        status: true,
        nextEpisodeAirDate: true,
        tmdbStatus: true,
        totalEpisodes: true,
        watchedEpisodes: true,
      },
    }),
    // Grouped in SQL: the alternative streams every episode row of every
    // tracked show into the server just to count the unwatched ones. A null
    // airDate is excluded — TMDB not knowing when something aired is not
    // evidence that it has, and the library's "New episodes" signal draws the
    // line in the same place.
    prisma.$queryRaw<WaitingRow[]>`
      SELECT t.id AS "id",
             t.name AS "name",
             t."posterPath" AS "posterPath",
             t.status::text AS "status",
             t."totalEpisodes" AS "totalEpisodes",
             t."watchedEpisodes" AS "watchedEpisodes",
             COUNT(e.id)::int AS "waiting",
             MAX(e."airDate") AS "latestAirDate"
      FROM "Title" t
      JOIN "Season" s ON s."titleId" = t.id
      JOIN "Episode" e ON e."seasonId" = s.id
      WHERE t."userId" = ${userId}
        AND t."deletedAt" IS NULL
        AND t."mediaType" = 'TV'::"MediaType"
        AND t.status <> 'DROPPED'::"WatchStatus"
        AND e.watched = false
        AND e."airDate" IS NOT NULL
        AND e."airDate" <= ${todayKey}::date
      GROUP BY t.id
      ORDER BY MAX(e."airDate") DESC, t.name ASC
      LIMIT ${WAITING_LIMIT}`,
    prisma.title.aggregate({
      where: { userId, deletedAt: null, mediaType: MediaType.TV },
      _count: { _all: true },
      _max: { metadataSyncedAt: true },
    }),
  ]);

  // One group per date, in the order the query already put them in.
  const groups: { dateKey: string; entries: AiringSoonEntry[] }[] = [];
  for (const t of airing) {
    if (!t.nextEpisodeAirDate) continue; // non-null by the filter; keeps it provable
    const key = dateKey(t.nextEpisodeAirDate);
    const entry: AiringSoonEntry = {
      id: t.id,
      name: t.name,
      posterPath: t.posterPath,
      status: t.status,
      airDateKey: key,
      tmdbStatus: t.tmdbStatus,
      totalEpisodes: t.totalEpisodes,
      watchedEpisodes: t.watchedEpisodes,
    };
    const last = groups[groups.length - 1];
    if (last && last.dateKey === key) last.entries.push(entry);
    else groups.push({ dateKey: key, entries: [entry] });
  }

  return {
    todayKey,
    groups,
    waiting: waitingRows.map((r) => ({
      id: r.id,
      name: r.name,
      posterPath: r.posterPath,
      status: r.status,
      waiting: r.waiting,
      latestAirDateKey: dateKey(r.latestAirDate),
      totalEpisodes: r.totalEpisodes,
      watchedEpisodes: r.watchedEpisodes,
    })),
    trackedShows: tracked._count._all,
    lastSyncedAt: tracked._max.metadataSyncedAt?.toISOString() ?? null,
  };
}
