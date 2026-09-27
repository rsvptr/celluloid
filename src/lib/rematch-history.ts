import type { TmdbSeasonDetails } from "@/lib/tmdb";

export interface RematchIdentity {
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV";
}

export interface EpisodeEventCoordinate {
  eventId: string;
  tmdbId: number | null;
  seasonNumber: number;
  episodeNumber: number;
}

export interface FreshEpisodeCoordinate {
  episodeId: string;
  tmdbId: number | null;
  seasonNumber: number;
  episodeNumber: number;
}

export interface EpisodeEventRelink {
  eventId: string;
  episodeId: string;
}

/**
 * Relinks per UPDATE statement. Each binds two values, which keeps a statement
 * well inside Postgres' 65,535-parameter limit. Prisma splits its own bulk
 * inserts at that limit, but not a raw statement.
 */
export const RELINK_BATCH_SIZE = 10_000;

/** Consecutive slices of at most `size` items, in order. */
export function chunks<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

/**
 * Episode state belongs to one TMDB series, not merely to matching season and
 * episode numbers. A genuine re-match must never transplant one show's history
 * into another show that happens to have an S01E01 of its own.
 */
export function preservesEpisodeHistory(
  current: RematchIdentity,
  next: RematchIdentity,
): boolean {
  return (
    current.mediaType === "TV" &&
    next.mediaType === "TV" &&
    current.tmdbId !== null &&
    current.tmdbId === next.tmdbId
  );
}

function coordinateKey(seasonNumber: number, episodeNumber: number): string {
  return `${seasonNumber}:${episodeNumber}`;
}

/** Shared predicate for progress, badges, and Upcoming episode queries. */
export const ACTIVE_EPISODE_FILTER = { withdrawnAt: null } as const;

/** Reserved range used when an active episode takes a withdrawn row's coordinate. */
export const WITHDRAWN_EPISODE_NUMBER_OFFSET = 2_000_000;

/** How recently an episode must have aired to still count as a discovery. */
const RECENT_AIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Date a newly materialized row from its own airing evidence. Back-catalogue
 * episodes belong to the title's creation cohort, while genuinely recent or
 * forward-scheduled episodes retain a useful discovery signal.
 */
export function discoveredAtForNewEpisode(
  airDate: Date | null,
  titleCreatedAt: Date,
  now: Date,
): Date {
  if (airDate === null) return now;
  if (airDate.getTime() > now.getTime()) return airDate;
  return airDate.getTime() >= now.getTime() - RECENT_AIR_WINDOW_MS
    ? now
    : titleCreatedAt;
}

/** TMDB calendar dates are UTC midnight. */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * When the next episode airs, or null once nothing is scheduled.
 *
 * TMDB's own `next_episode_to_air` is authoritative but frequently absent for
 * smaller and regional shows, so the earliest future air date across the
 * seasons we just read stands in for it. Returning null when neither knows is
 * deliberate: it clears a date that has since passed, so the airing-soon view
 * never advertises an episode that already aired.
 */
export function deriveNextEpisodeAirDate(
  tmdbNextAirDate: string | null | undefined,
  seasons: TmdbSeasonDetails[],
  now: Date,
): Date | null {
  const today = startOfUtcDay(now).getTime();
  const stated = toDate(tmdbNextAirDate);
  if (stated && stated.getTime() >= today) return stated;

  let earliest: Date | null = null;
  for (const season of seasons) {
    for (const ep of season.episodes ?? []) {
      const airs = toDate(ep.air_date);
      if (!airs || airs.getTime() < today) continue;
      if (earliest === null || airs.getTime() < earliest.getTime()) earliest = airs;
    }
  }
  return earliest;
}

/** Air dates are calendar dates, so "future" is measured from midnight, not now. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

/**
 * A TV show's typical episode length in minutes, or null when nothing says.
 *
 * TMDB's `episode_run_time` is empty for most current shows, so the median of
 * the loaded episodes' own runtimes stands in for it: the median rather than
 * the mean, so a double-length finale or a short special doesn't skew it.
 * Zero and missing runtimes are TMDB not knowing, never a length.
 */
export function tvRuntime(
  episodeRunTime: readonly number[] | null | undefined,
  seasons: readonly TmdbSeasonDetails[],
): number | null {
  const stated = episodeRunTime?.[0];
  if (stated && stated > 0) return stated;
  const runtimes = seasons
    .flatMap((season) => (season.episodes ?? []).map((ep) => ep.runtime))
    .filter((runtime): runtime is number => typeof runtime === "number" && runtime > 0)
    .sort((a, b) => a - b);
  if (runtimes.length === 0) return null;
  const middle = Math.floor(runtimes.length / 2);
  return runtimes.length % 2 === 1
    ? runtimes[middle]
    : Math.round((runtimes[middle - 1] + runtimes[middle]) / 2);
}

/**
 * Reconnect historical events to replacement Episode rows after a same-series
 * refresh. A TMDB id follows the episode through renumbering; only legacy rows
 * without one use their old coordinate as a best-effort fallback.
 */
export function planEpisodeEventRelinks(
  shouldRelink: boolean,
  events: readonly EpisodeEventCoordinate[],
  freshEpisodes: readonly FreshEpisodeCoordinate[],
): EpisodeEventRelink[] {
  if (!shouldRelink || events.length === 0 || freshEpisodes.length === 0) return [];

  const freshByTmdbId = new Map(
    freshEpisodes.flatMap((episode) =>
      episode.tmdbId === null ? [] : [[episode.tmdbId, episode.episodeId] as const],
    ),
  );
  const freshByCoordinate = new Map(
    freshEpisodes.map((episode) => [
      coordinateKey(episode.seasonNumber, episode.episodeNumber),
      episode.episodeId,
    ]),
  );

  return events.flatMap((event) => {
    // Once TMDB supplied an identity, never fall back to a mutable coordinate:
    // a renumbering must move the event with the episode rather than attach it
    // to whatever now occupies the old number. Coordinate fallback exists only
    // for legacy rows that predate a stored TMDB id.
    const episodeId =
      event.tmdbId === null
        ? freshByCoordinate.get(coordinateKey(event.seasonNumber, event.episodeNumber))
        : freshByTmdbId.get(event.tmdbId);
    return episodeId ? [{ eventId: event.eventId, episodeId }] : [];
  });
}
