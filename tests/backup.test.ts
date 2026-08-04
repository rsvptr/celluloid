import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { register } from "node:module";
import {
  backupEnvelopeSchema,
  mergeBackupTitle,
  parseBackupEnvelope,
  planRestoreTitles,
  type BackupEnvelope,
  type BackupTitle,
  type RestoreMode,
  type RestorePreviewCounts,
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
  user: {
    timeZone: "Europe/London",
    watchRegion: "GB",
    myProviders: [8, 337],
    recommendModel: "claude-opus-5",
  },
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
  suppressions: [
    {
      sourceId: "suppression-source",
      matchKey: "tmdb:TV:909",
      tmdbId: 909,
      mediaType: "TV",
      name: "A Refused Series",
      year: 2025,
      reason: "NOT_INTERESTED",
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
    assert.deepEqual(parsed.user.myProviders, [8, 337]);
    assert.equal(parsed.user.recommendModel, "claude-opus-5");
    assert.equal(parsed.suppressions?.[0].matchKey, "tmdb:TV:909");
    assert.deepEqual(parsed.shares[0].items.map((item) => item.titleId), [
      movie.sourceId,
      tv.sourceId,
    ]);
    assert.equal("slug" in parsed.shares[0], false);
  });

  it("parses old v2 TMDB prose but also accepts the lean shape new exports emit", () => {
    const verboseV2 = structuredClone(envelope);
    const verboseSeason = verboseV2.titles[1].seasons[0];
    verboseSeason.overview = "Season synopsis ".repeat(2_000);
    verboseSeason.episodes[0].overview = "Episode synopsis ".repeat(2_000);
    verboseSeason.episodes[0].stillPath = "/large-derived-still.jpg";

    const oldParsed = parseBackupEnvelope(verboseV2);
    assert.equal(oldParsed.titles[1].seasons[0].overview, verboseSeason.overview);
    assert.equal(
      oldParsed.titles[1].seasons[0].episodes[0].stillPath,
      "/large-derived-still.jpg",
    );

    const leanV2 = structuredClone(verboseV2);
    for (const title of leanV2.titles) {
      for (const season of title.seasons) {
        delete season.overview;
        for (const episode of season.episodes) {
          delete episode.overview;
          delete episode.stillPath;
        }
      }
    }
    const leanParsed = parseBackupEnvelope(leanV2);
    assert.equal(leanParsed.titles[1].seasons[0].overview, undefined);
    assert.equal(leanParsed.titles[1].seasons[0].episodes[0].overview, undefined);
    assert.equal(leanParsed.titles[1].seasons[0].episodes[0].stillPath, undefined);
    assert.ok(
      JSON.stringify(leanParsed).length < JSON.stringify(oldParsed).length / 2,
      "omitting re-fetchable prose should materially shrink the envelope",
    );
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

  it("rejects duplicate suppression keys before restore", () => {
    const parsed = backupEnvelopeSchema.safeParse({
      ...envelope,
      suppressions: [
        ...(envelope.suppressions ?? []),
        {
          ...(envelope.suppressions ?? [])[0],
          sourceId: "suppression-copy",
        },
      ],
    });
    assert.equal(parsed.success, false);
    assert.match(
      parsed.success ? "" : parsed.error.issues.map((issue) => issue.message).join(" "),
      /duplicate suppression matchKey/,
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

  it("still parses v2 files downloaded before preference and suppression fields existed", () => {
    const legacyV2 = structuredClone(envelope);
    delete legacyV2.user.myProviders;
    delete legacyV2.user.recommendModel;
    delete legacyV2.suppressions;

    const parsed = parseBackupEnvelope(legacyV2);

    assert.equal(parsed.schemaVersion, 2);
    assert.equal(parsed.user.myProviders, undefined);
    assert.equal(parsed.user.recommendModel, undefined);
    assert.equal(parsed.suppressions, undefined);
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

describe("backup merge policy — denormalized episode counters", () => {
  // Regression: mergeBackupTitle used to carry the EXISTING totals through
  // `fillNullable` while unioning the season/episode rows underneath them, so a
  // restore that added a season left Title.totalEpisodes describing the
  // pre-restore library. The progress bar then read e.g. "12/2 eps" forever and
  // stats' episodesTotal undercounted. These lock the counters to the rows the
  // merge actually persists.

  /** A second season the local copy doesn't have, with 3 episodes (1 watched). */
  const seasonTwo = {
    sourceId: "season-two-source",
    tmdbId: 306,
    seasonNumber: 2,
    name: "Season 2",
    overview: null,
    airDate: "2024-09-01T00:00:00.000Z",
    posterPath: null,
    episodeCount: 3,
    episodes: [1, 2, 3].map((n) => ({
      sourceId: `s2e${n}-source`,
      tmdbId: 500 + n,
      episodeNumber: n,
      name: `S2E${n}`,
      overview: null,
      airDate: "2024-09-01T00:00:00.000Z",
      runtime: 45,
      stillPath: null,
      watched: n === 1,
      watchedAt: n === 1 ? "2026-07-10T20:00:00.000Z" : null,
    })),
  };

  it("recounts totalEpisodes from the union when the backup adds a season", () => {
    // Local: season 1 only (2 episodes). Incoming: seasons 1 and 2 (5 total).
    const localTv: BackupTitle = { ...tv, sourceId: "local-tv" };
    const incoming: BackupTitle = { ...tv, seasons: [...tv.seasons, seasonTwo] };

    const merged = mergeBackupTitle(localTv, incoming, "merge");

    const actualEpisodes = merged.seasons.reduce(
      (n, season) => n + season.episodes.length,
      0,
    );
    assert.equal(actualEpisodes, 5, "union should hold both seasons' episodes");
    assert.equal(merged.totalEpisodes, 5, "totalEpisodes must match the union");
    assert.equal(merged.totalSeasons, 2, "totalSeasons must match the union");
  });

  it("recounts watchedEpisodes from the merged rows, not the stale cache", () => {
    // Local claims 1 watched; the incoming season 2 contributes another.
    const localTv: BackupTitle = { ...tv, sourceId: "local-tv", watchedEpisodes: 1 };
    const incoming: BackupTitle = { ...tv, seasons: [...tv.seasons, seasonTwo] };

    const merged = mergeBackupTitle(localTv, incoming, "merge");

    const actualWatched = merged.seasons.reduce(
      (n, season) => n + season.episodes.filter((e) => e.watched).length,
      0,
    );
    assert.equal(actualWatched, 2);
    assert.equal(merged.watchedEpisodes, 2);
  });

  it("never lets totalSeasons understate a known-good TMDB season count", () => {
    // TMDB reports 4 seasons but only 1 is materialized locally (specials and
    // unaired seasons aren't stored), so the row count must not clobber it.
    const localTv: BackupTitle = { ...tv, sourceId: "local-tv", totalSeasons: 4 };

    const merged = mergeBackupTitle(localTv, tv, "merge");

    assert.equal(merged.totalSeasons, 4);
  });

  it("leaves movie counters alone (no season rows to count)", () => {
    const localMovie: BackupTitle = { ...movie, sourceId: "local-movie" };

    const merged = mergeBackupTitle(localMovie, movie, "merge");

    assert.equal(merged.totalEpisodes, null);
    assert.equal(merged.totalSeasons, null);
    assert.equal(merged.watchedEpisodes, 0);
  });

  it("keeps the restore preview honest: the plan's merged title carries the recount", () => {
    // planRestoreTitles calls mergeBackupTitle, so the confirmation dialog's
    // counts and the applied write must agree on the same numbers.
    const localTv: BackupTitle = { ...tv, sourceId: "local-tv" };
    const incoming: BackupTitle = { ...tv, seasons: [...tv.seasons, seasonTwo] };

    const plan = planRestoreTitles([incoming], [localTv], "merge");

    assert.equal(plan.counts.update, 1);
    const item = plan.items[0];
    assert.equal(item.action, "update");
    assert.equal(item.action === "update" ? item.merged.totalEpisodes : null, 5);
  });

  it("treats a pure recount as a real update, not a phantom skip", () => {
    // A local row whose cached totals are already wrong must be planned as an
    // update so the fix actually reaches the database.
    const staleLocal: BackupTitle = { ...tv, sourceId: "local-tv", totalEpisodes: 99 };

    const plan = planRestoreTitles([tv], [staleLocal], "merge");

    assert.equal(plan.counts.update, 1);
    assert.equal(plan.counts.skip, 0);
  });
});

// --- Restore confirmation (SB-4) ---------------------------------------------
//
// createRestoreConfirmation/verifyRestoreConfirmation (src/lib/backup.ts) sign
// the token that gates "preview a restore" from "actually mutate the library",
// so this section needs two bits of setup the rest of the file doesn't:
//
// 1. backup.ts starts with `import "server-only"`. That package's export map
//    sends plain Node to `index.js`, which throws unconditionally — it only
//    resolves to the no-op `empty.js` under the "react-server" export
//    condition, which is a condition Next's own bundler sets and a plain
//    `node --test` process never does. Left alone, statically importing
//    backup.ts here would throw at module load and take the whole file down.
//    The resolve hook below makes plain Node treat "server-only" the same way
//    Next treats it inside server code: a no-op.
// 2. backup.ts imports `env` from "@/lib/env", which parses and validates the
//    *entire* process environment the moment it is first evaluated. So
//    DATABASE_URL, BETTER_AUTH_SECRET, and TMDB_ACCESS_TOKEN must already be
//    set before that first import — set directly here, same as
//    crypto.test.ts's ENCRYPTION_KEY, with values that are obviously not real
//    credentials.
//
// Both have to happen before backup.ts loads, so the import below is a
// (top-level-awaited) dynamic import rather than the usual static one — the
// only reason this section doesn't just `import { ... } from "../src/lib/backup"`
// at the top of the file like everything else.
//
// No changes were made to src/lib/backup.ts: everything here goes through the
// same createRestoreConfirmation/verifyRestoreConfirmation the app calls.

const RESTORE_TEST_SECRET = "restore-confirmation-test-secret-not-a-real-value";
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET = RESTORE_TEST_SECRET;
process.env.TMDB_ACCESS_TOKEN = "test-tmdb-token";

const serverOnlyShim = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  return nextResolve(specifier, context);
}
`;
// `register` (not the newer `registerHooks`) is deliberate: the installed
// @types/node (^20) doesn't know about `registerHooks` yet even though the
// Node binary running these tests does, so `registerHooks` fails `tsc`/
// `next build` type-checking. `register` is older and slated for eventual
// removal in favor of `registerHooks`, but it is fully typed today and this
// process only needs the hook for the lifetime of this one test file.
register(`data:text/javascript,${encodeURIComponent(serverOnlyShim)}`, import.meta.url);

const { createRestoreConfirmation, verifyRestoreConfirmation } = await import(
  "../src/lib/backup"
);

/**
 * Mirrors confirmationPayload() plus the signing half of
 * createRestoreConfirmation() (backup.ts, just above verifyRestoreConfirmation)
 * using the same primitives, so a test can mint a token with an arbitrary
 * issuedAt — in particular, one stale enough to have already expired — without
 * reaching into the module's unexported functions.
 */
function signRestoreToken(
  userId: string,
  mode: RestoreMode,
  bytes: Uint8Array,
  counts: RestorePreviewCounts,
  stateDigest: string,
  issuedAt: number,
): string {
  const digest = createHash("sha256").update(bytes).digest("base64url");
  const countValues = [
    counts.create,
    counts.update,
    counts.skip,
    counts.conflict,
    counts.suppressionsCreate,
    counts.suppressionsUpdate,
    counts.suppressionsSkip,
    counts.providerSelections,
    counts.providerPreferenceIncluded,
    counts.providerPreferenceUpdate,
    counts.recommendModelPreferenceIncluded,
    counts.recommendModelPreferenceUpdate,
  ];
  const payload = [
    userId,
    mode,
    digest,
    stateDigest,
    issuedAt,
    ...countValues,
  ].join(":");
  const signature = createHmac("sha256", RESTORE_TEST_SECRET)
    .update(payload)
    .digest("base64url");
  return [issuedAt, ...countValues, signature].join(".");
}

describe("restore confirmation", () => {
  const userId = "user-restore-1";
  const mode: RestoreMode = "merge";
  const bytes = new TextEncoder().encode("backup-file-bytes");
  const stateDigest = "current-restore-state-digest";
  const counts: RestorePreviewCounts = {
    create: 2,
    update: 1,
    skip: 3,
    conflict: 0,
    suppressionsCreate: 4,
    suppressionsUpdate: 0,
    suppressionsSkip: 1,
    providerSelections: 2,
    providerPreferenceIncluded: 1,
    providerPreferenceUpdate: 1,
    recommendModelPreferenceIncluded: 1,
    recommendModelPreferenceUpdate: 1,
  };

  it("round-trips: verify succeeds for the same userId, mode, bytes, and counts", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    assert.equal(
      verifyRestoreConfirmation(token, userId, mode, bytes, counts, stateDigest),
      true,
    );
  });

  it("rejects a token past the 15-minute TTL", () => {
    const staleIssuedAt = Date.now() - (15 * 60 * 1000 + 1_000);
    const token = signRestoreToken(userId, mode, bytes, counts, stateDigest, staleIssuedAt);
    assert.equal(
      verifyRestoreConfirmation(token, userId, mode, bytes, counts, stateDigest),
      false,
    );
  });

  it("still accepts a token minted just inside the 15-minute TTL", () => {
    // Same hand-signed path as the expiry test, just under the wire instead of
    // over it — pins the boundary as inclusive (backup.ts compares with `>`,
    // not `>=`) rather than merely "old tokens eventually stop working".
    const freshIssuedAt = Date.now() - 14 * 60 * 1000;
    const token = signRestoreToken(userId, mode, bytes, counts, stateDigest, freshIssuedAt);
    assert.equal(
      verifyRestoreConfirmation(token, userId, mode, bytes, counts, stateDigest),
      true,
    );
  });

  it("rejects a token whose signature has been tampered with", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    const parts = token.split(".");
    const signature = parts.at(-1) ?? "";
    const flipped = signature.slice(0, -2) + (signature.endsWith("AA") ? "BB" : "AA");
    const tampered = [...parts.slice(0, -1), flipped].join(".");
    assert.equal(
      verifyRestoreConfirmation(tampered, userId, mode, bytes, counts, stateDigest),
      false,
    );
  });

  it("rejects a stale preview: any single count field drifting from the token's", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    const countKeys: Array<keyof RestorePreviewCounts> = [
      "create",
      "update",
      "skip",
      "conflict",
      "suppressionsCreate",
      "suppressionsUpdate",
      "suppressionsSkip",
      "providerSelections",
      "providerPreferenceIncluded",
      "providerPreferenceUpdate",
      "recommendModelPreferenceIncluded",
      "recommendModelPreferenceUpdate",
    ];
    for (const key of countKeys) {
      const drifted: RestorePreviewCounts = { ...counts, [key]: counts[key] + 1 };
      assert.equal(
        verifyRestoreConfirmation(token, userId, mode, bytes, drifted, stateDigest),
        false,
        `expected rejection when ${key} drifts from ${counts[key]} to ${drifted[key]}`,
      );
    }
  });

  it("rejects verification for a different userId", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    assert.equal(
      verifyRestoreConfirmation(
        token,
        "a-different-user",
        mode,
        bytes,
        counts,
        stateDigest,
      ),
      false,
    );
  });

  it("rejects verification for a different restore mode", () => {
    const token = createRestoreConfirmation(userId, "merge", bytes, counts, stateDigest);
    assert.equal(
      verifyRestoreConfirmation(
        token,
        userId,
        "replace-personal",
        bytes,
        counts,
        stateDigest,
      ),
      false,
    );
  });

  it("rejects verification against different file bytes", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    const differentBytes = new TextEncoder().encode("a completely different backup file");
    assert.equal(
      verifyRestoreConfirmation(token, userId, mode, differentBytes, counts, stateDigest),
      false,
    );
  });

  it("rejects the same counts when the current restore state has changed", () => {
    const token = createRestoreConfirmation(userId, mode, bytes, counts, stateDigest);
    assert.equal(
      verifyRestoreConfirmation(
        token,
        userId,
        mode,
        bytes,
        counts,
        "different-current-state-digest",
      ),
      false,
    );
  });

  it("rejects a malformed token that doesn't have the complete count payload", () => {
    assert.equal(
      verifyRestoreConfirmation(
        "not-a-real-token",
        userId,
        mode,
        bytes,
        counts,
        stateDigest,
      ),
      false,
    );
  });

  it("rejects a token issued in the future (clock skew)", () => {
    const futureIssuedAt = Date.now() + 5 * 60 * 1000;
    const token = signRestoreToken(userId, mode, bytes, counts, stateDigest, futureIssuedAt);
    assert.equal(
      verifyRestoreConfirmation(token, userId, mode, bytes, counts, stateDigest),
      false,
    );
  });
});
