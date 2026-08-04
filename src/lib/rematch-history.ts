export interface RematchIdentity {
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV";
}

export interface EpisodeEventCoordinate {
  eventId: string;
  seasonNumber: number;
  episodeNumber: number;
}

export interface FreshEpisodeCoordinate {
  episodeId: string;
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

/**
 * Reconnect historical events to replacement Episode rows after a same-series
 * refresh. Coordinates absent from the refreshed TMDB payload deliberately
 * remain detached: guessing a different episode would corrupt the log.
 */
export function planEpisodeEventRelinks(
  shouldRelink: boolean,
  events: readonly EpisodeEventCoordinate[],
  freshEpisodes: readonly FreshEpisodeCoordinate[],
): EpisodeEventRelink[] {
  if (!shouldRelink || events.length === 0 || freshEpisodes.length === 0) return [];

  const freshByCoordinate = new Map(
    freshEpisodes.map((episode) => [
      coordinateKey(episode.seasonNumber, episode.episodeNumber),
      episode.episodeId,
    ]),
  );

  return events.flatMap((event) => {
    const episodeId = freshByCoordinate.get(
      coordinateKey(event.seasonNumber, event.episodeNumber),
    );
    return episodeId ? [{ eventId: event.eventId, episodeId }] : [];
  });
}
