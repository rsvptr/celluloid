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
