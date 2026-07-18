import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  backupEnvelopeSchema,
  mergeBackupTitle,
  parseBackupEnvelope,
  planRestoreTitles,
  type BackupEnvelope,
  type BackupTitle,
} from "../src/lib/backup-format";

const stamp = "2026-07-17T12:00:00.000Z";

const movie: BackupTitle = {
  sourceId: "movie-source",
  tmdbId: 101,
  mediaType: "MOVIE",
  name: "A Film",
  originalName: null,
  overview: "A restored movie fixture.",
  releaseDate: "2024-02-01T00:00:00.000Z",
  posterPath: "/movie.jpg",
  backdropPath: null,
  language: "en",
  tmdbRating: 7.2,
  runtime: 112,
  genres: ["Drama"],
  status: "WATCHED",
  rating: 8.5,
  notes: "Keep this private note.",
  watchedAt: "2026-06-01T20:00:00.000Z",
  favorite: true,
  totalSeasons: null,
  totalEpisodes: null,
  watchedEpisodes: 0,
  source: "tmdb",
  deletedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  seasons: [],
  tags: ["Favourites"],
};

const tv: BackupTitle = {
  sourceId: "tv-source",
  tmdbId: 202,
  mediaType: "TV",
  name: "A Series",
  originalName: null,
  overview: "A restored TV fixture.",
  releaseDate: "2023-09-01T00:00:00.000Z",
  posterPath: "/series.jpg",
  backdropPath: "/series-wide.jpg",
  language: "en",
  tmdbRating: 8.1,
  runtime: null,
  genres: ["Mystery"],
  status: "WATCHING",
  rating: 9,
  notes: "Continue with episode 2.",
  watchedAt: null,
  favorite: false,
  totalSeasons: 1,
  totalEpisodes: 2,
  watchedEpisodes: 1,
  source: "tmdb",
  deletedAt: null,
  createdAt: stamp,
  updatedAt: stamp,
  seasons: [
    {
      sourceId: "season-source",
      tmdbId: 303,
      seasonNumber: 1,
      name: "Season 1",
      overview: null,
      airDate: "2023-09-01T00:00:00.000Z",
      posterPath: null,
      episodeCount: 2,
      episodes: [
        {
          sourceId: "episode-one-source",
          tmdbId: 404,
          episodeNumber: 1,
          name: "The Beginning",
          overview: null,
          airDate: "2023-09-01T00:00:00.000Z",
          runtime: 48,
          stillPath: null,
          watched: true,
          watchedAt: "2026-07-01T20:00:00.000Z",
        },
        {
          sourceId: "episode-two-source",
          tmdbId: 405,
          episodeNumber: 2,
          name: "The Next Part",
          overview: null,
          airDate: "2023-09-08T00:00:00.000Z",
          runtime: 49,
          stillPath: null,
          watched: false,
          watchedAt: null,
        },
      ],
    },
  ],
  tags: ["Weekend"],
};

const envelope: BackupEnvelope = {
  app: "celluloid",
  schemaVersion: 2,
  exportedAt: stamp,
  user: { timeZone: "Europe/London", watchRegion: "GB" },
  titles: [movie, tv],
  tags: [
    { sourceId: "tag-favourite", name: "Favourites", color: "#f59e0b", createdAt: stamp },
    { sourceId: "tag-weekend", name: "Weekend", color: null, createdAt: stamp },
  ],
  shares: [
    {
      sourceId: "share-source",
      name: "Watched together",
      titleIds: [movie.sourceId, tv.sourceId],
      includeNotes: false,
      includeWatchlist: false,
      scope: "SELECTION",
      expiresAt: "2026-10-15T12:00:00.000Z",
      revokedAt: null,
      items: [
        { titleId: movie.sourceId, position: 1 },
        { titleId: tv.sourceId, position: 2 },
      ],
      createdAt: stamp,
    },
  ],
  watchEvents: [
    {
      sourceId: "event-movie-completed",
      titleId: movie.sourceId,
      episodeId: null,
      kind: "TITLE_COMPLETED",
      occurredAt: "2026-06-01T20:00:00.000Z",
      source: "MANUAL",
      note: "Cinema night",
      createdAt: stamp,
    },
    {
      sourceId: "event-episode-one",
      titleId: tv.sourceId,
      episodeId: "episode-one-source",
      kind: "EPISODE_WATCHED",
      occurredAt: "2026-07-01T20:00:00.000Z",
      source: "MANUAL",
      note: null,
      createdAt: stamp,
    },
  ],
};

describe("Celluloid backup envelope", () => {
  it("round-trips a movie, TV progress, tags, notes, ratings, and share metadata", () => {
    const parsed = backupEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    assert.deepEqual(parsed, envelope);
    assert.equal(parsed.titles[0].notes, "Keep this private note.");
    assert.equal(parsed.titles[0].rating, 8.5);
    assert.equal(parsed.titles[1].seasons[0].episodes[0].watched, true);
    assert.deepEqual(parsed.titles[1].tags, ["Weekend"]);
    assert.equal(parsed.watchEvents[1].episodeId, "episode-one-source");
    assert.equal(parsed.user.timeZone, "Europe/London");
    assert.deepEqual(parsed.shares[0].items.map((item) => item.titleId), [
      movie.sourceId,
      tv.sourceId,
    ]);
    assert.equal("slug" in parsed.shares[0], false);
  });

  it("rejects the wrong app/version, unknown secret fields, and broken joins", () => {
    assert.equal(backupEnvelopeSchema.safeParse({ ...envelope, app: "excel" }).success, false);
    assert.equal(
      backupEnvelopeSchema.safeParse({ ...envelope, schemaVersion: 3 }).success,
      false,
    );
    assert.equal(
      backupEnvelopeSchema.safeParse({
        ...envelope,
        shares: [{ ...envelope.shares[0], slug: "bearer-secret" }],
      }).success,
      false,
    );
    assert.equal(
      backupEnvelopeSchema.safeParse({
        ...envelope,
        shares: [{ ...envelope.shares[0], titleIds: ["missing-title"] }],
      }).success,
      false,
    );
    assert.equal(
      backupEnvelopeSchema.safeParse({
        ...envelope,
        user: { ...envelope.user, timeZone: "Mars/Olympus" },
      }).success,
      false,
    );
  });

  it("rejects case-insensitive tag duplicates before restore", () => {
    const parsed = backupEnvelopeSchema.safeParse({
      ...envelope,
      tags: [
        ...envelope.tags,
        { sourceId: "tag-lowercase", name: "weekend", color: null, createdAt: stamp },
      ],
    });
    assert.equal(parsed.success, false);
    assert.match(
      parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" "),
      /duplicate tag name/,
    );
  });

  it("rejects values that violate title and episode database checks", () => {
    for (const rating of [0, 8.1]) {
      assert.equal(
        backupEnvelopeSchema.safeParse({
          ...envelope,
          titles: [{ ...movie, rating }, tv],
        }).success,
        false,
      );
    }

    assert.equal(
      backupEnvelopeSchema.safeParse({
        ...envelope,
        titles: [movie, { ...tv, watchedEpisodes: 3 }],
      }).success,
      false,
    );

    const invalidEpisodeEnvelope = structuredClone(envelope);
    invalidEpisodeEnvelope.titles[1].seasons[0].episodes[1].watchedAt = stamp;
    assert.equal(backupEnvelopeSchema.safeParse(invalidEpisodeEnvelope).success, false);
  });

  it("rejects duplicate media type and TMDB id pairs in one envelope", () => {
    const parsed = backupEnvelopeSchema.safeParse({
      ...envelope,
      titles: [movie, { ...movie, sourceId: "movie-copy" }],
    });
    assert.equal(parsed.success, false);
    assert.match(
      parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" "),
      /duplicate media type and TMDB id/,
    );
  });

  it("upgrades a strict v1 envelope to v2 defaults without inventing watch events", () => {
    const v1Titles = envelope.titles.map(({ deletedAt, ...title }) => {
      void deletedAt;
      return title;
    });
    const v1Shares = envelope.shares.map(
      ({ scope, expiresAt, revokedAt, items, ...share }) => {
        void scope;
        void expiresAt;
        void revokedAt;
        void items;
        return share;
      },
    );
    const upgraded = parseBackupEnvelope({
      app: "celluloid",
      schemaVersion: 1,
      exportedAt: envelope.exportedAt,
      titles: v1Titles,
      tags: envelope.tags,
      shares: v1Shares,
    });

    assert.equal(upgraded.schemaVersion, 2);
    assert.deepEqual(upgraded.user, { timeZone: "UTC", watchRegion: "US" });
    assert.deepEqual(upgraded.watchEvents, []);
    assert.equal(upgraded.titles[0].deletedAt, null);
    assert.equal(upgraded.shares[0].scope, "SELECTION");
    assert.deepEqual(upgraded.shares[0].items, [
      { titleId: movie.sourceId, position: 1 },
      { titleId: tv.sourceId, position: 2 },
    ]);
  });
});

describe("backup merge policy", () => {
  it("creates complete movie and TV fixtures when no local title exists", () => {
    assert.deepEqual(mergeBackupTitle(null, movie, "merge"), movie);
    assert.deepEqual(mergeBackupTitle(null, tv, "merge"), tv);
    assert.deepEqual(planRestoreTitles(envelope.titles, [], "merge").counts, {
      create: 2,
      update: 0,
      skip: 0,
      conflict: 0,
    });
  });

  it("merge fills nullable gaps without replacing existing personal fields", () => {
    const local: BackupTitle = {
      ...movie,
      sourceId: "local-movie",
      status: "WATCHLIST",
      rating: 9.5,
      notes: "Local note wins.",
      watchedAt: null,
      favorite: false,
      tags: ["Local"],
    };
    const merged = mergeBackupTitle(local, movie, "merge");
    assert.equal(merged.status, "WATCHLIST");
    assert.equal(merged.rating, 9.5);
    assert.equal(merged.notes, "Local note wins.");
    assert.equal(merged.favorite, false);
    assert.equal(merged.watchedAt, movie.watchedAt);
    assert.deepEqual(merged.tags, ["Favourites", "Local"]);
  });

  it("replace-personal makes backup tracking and episode progress authoritative", () => {
    const localTv: BackupTitle = {
      ...tv,
      sourceId: "local-tv",
      status: "WATCHLIST",
      rating: null,
      notes: "Local draft",
      watchedEpisodes: 0,
      tags: ["Local"],
      seasons: tv.seasons.map((season) => ({
        ...season,
        sourceId: "local-season",
        episodes: season.episodes.map((episode) => ({
          ...episode,
          sourceId: `local-${episode.sourceId}`,
          watched: false,
          watchedAt: null,
        })),
      })),
    };

    const merged = mergeBackupTitle(localTv, tv, "merge");
    assert.equal(merged.seasons[0].episodes[0].watched, false);
    assert.equal(merged.notes, "Local draft");

    const replaced = mergeBackupTitle(localTv, tv, "replace-personal");
    assert.equal(replaced.status, "WATCHING");
    assert.equal(replaced.rating, 9);
    assert.equal(replaced.notes, "Continue with episode 2.");
    assert.equal(replaced.watchedEpisodes, 1);
    assert.equal(replaced.seasons[0].episodes[0].watched, true);
    assert.equal(
      replaced.seasons[0].episodes[0].watchedAt,
      "2026-07-01T20:00:00.000Z",
    );
    assert.deepEqual(replaced.tags, ["Weekend"]);
  });

  it("is idempotent when the same snapshots already exist", () => {
    assert.deepEqual(planRestoreTitles(envelope.titles, envelope.titles, "merge").counts, {
      create: 0,
      update: 0,
      skip: 2,
      conflict: 0,
    });
  });

  it("reports a source-id collision with a different title as a conflict", () => {
    const unrelated: BackupTitle = {
      ...movie,
      tmdbId: 999,
      name: "A Different Film",
    };
    assert.deepEqual(planRestoreTitles([movie], [unrelated], "merge").counts, {
      create: 0,
      update: 0,
      skip: 0,
      conflict: 1,
    });
  });

  it("reports a TMDB-id fill that would violate local uniqueness as a conflict", () => {
    const manual: BackupTitle = {
      ...movie,
      sourceId: "manual-movie",
      tmdbId: null,
    };
    const alreadyMatched: BackupTitle = {
      ...movie,
      sourceId: "matched-movie",
    };
    const incoming: BackupTitle = {
      ...movie,
      sourceId: manual.sourceId,
    };

    assert.deepEqual(
      planRestoreTitles([incoming], [manual, alreadyMatched], "merge").counts,
      { create: 0, update: 0, skip: 0, conflict: 1 },
    );
  });

  it("merge never changes local trash state, in either direction", () => {
    const trashedStamp = "2026-07-10T09:00:00.000Z";

    // A live local title stays live even when the backup copy is trashed — a
    // nullable-fill would have silently soft-deleted it.
    const liveLocal: BackupTitle = { ...movie, sourceId: "local", deletedAt: null };
    const trashedBackup: BackupTitle = { ...movie, deletedAt: trashedStamp };
    assert.equal(mergeBackupTitle(liveLocal, trashedBackup, "merge").deletedAt, null);

    // A trashed local title stays trashed even when the backup copy is live.
    const trashedLocal: BackupTitle = {
      ...movie,
      sourceId: "local",
      deletedAt: trashedStamp,
    };
    const liveBackup: BackupTitle = { ...movie, deletedAt: null };
    assert.equal(
      mergeBackupTitle(trashedLocal, liveBackup, "merge").deletedAt,
      trashedStamp,
    );
  });

  it("replace-personal makes the backup's trash state authoritative", () => {
    const trashedStamp = "2026-07-10T09:00:00.000Z";

    // Backup trashed -> local adopts the trashed marker.
    const liveLocal: BackupTitle = { ...movie, sourceId: "local", deletedAt: null };
    const trashedBackup: BackupTitle = { ...movie, deletedAt: trashedStamp };
    assert.equal(
      mergeBackupTitle(liveLocal, trashedBackup, "replace-personal").deletedAt,
      trashedStamp,
    );

    // Backup live -> local drops its trashed marker.
    const trashedLocal: BackupTitle = {
      ...movie,
      sourceId: "local",
      deletedAt: trashedStamp,
    };
    const liveBackup: BackupTitle = { ...movie, deletedAt: null };
    assert.equal(
      mergeBackupTitle(trashedLocal, liveBackup, "replace-personal").deletedAt,
      null,
    );
  });
});

// --- Added for D-F9 follow-up test coverage ---------------------------------
// (see tests/import-staging.test.ts for the matching deriveImportJobStatus
// addition). Each block below is self-contained and does not touch the
// existing fixtures' shape.

describe("backup merge policy — ambiguous name+year fallback", () => {
  it("reports >1 name+year candidates as a conflict rather than guessing a skip/update", () => {
    // Neither existing row shares movie.sourceId or a tmdbId with the incoming
    // row, so the planner falls all the way through to the name+year fallback
    // match — where it finds two equally plausible candidates.
    const existingA: BackupTitle = { ...movie, sourceId: "existing-a", tmdbId: null };
    const existingB: BackupTitle = { ...movie, sourceId: "existing-b", tmdbId: null };
    const incoming: BackupTitle = { ...movie, sourceId: "incoming-unmatched", tmdbId: null };

    const plan = planRestoreTitles([incoming], [existingA, existingB], "merge");

    assert.deepEqual(plan.counts, { create: 0, update: 0, skip: 0, conflict: 1 });
    assert.deepEqual(plan.items, [{ action: "conflict", incoming }]);
  });
});

describe("backup merge policy — tag union casing", () => {
  it("'Action' + 'action' -> one tag, existing casing wins", () => {
    const existing: BackupTitle = { ...movie, sourceId: "local-movie", tags: ["Action"] };
    const incoming: BackupTitle = { ...movie, tags: ["action"] };

    const merged = mergeBackupTitle(existing, incoming, "merge");

    assert.deepEqual(merged.tags, ["Action"]);
  });
});
