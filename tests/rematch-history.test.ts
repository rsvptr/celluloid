import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chunks,
  planEpisodeEventRelinks,
  preservesEpisodeHistory,
  RELINK_BATCH_SIZE,
  tvRuntime,
} from "../src/lib/rematch-history";

const events = [
  { eventId: "event-1", tmdbId: 101, seasonNumber: 1, episodeNumber: 1, withdrawn: false },
  { eventId: "event-2", tmdbId: 102, seasonNumber: 1, episodeNumber: 2, withdrawn: false },
  { eventId: "event-3", tmdbId: null, seasonNumber: 2, episodeNumber: 1, withdrawn: false },
];

const freshEpisodes = [
  { episodeId: "fresh-s1e1", tmdbId: 101, seasonNumber: 1, episodeNumber: 1, withdrawn: false },
  { episodeId: "fresh-s1e2", tmdbId: 102, seasonNumber: 1, episodeNumber: 2, withdrawn: false },
];

describe("rematch episode-history policy", () => {
  it("relinks events by season and episode on a same-TMDB TV refresh", () => {
    const preserve = preservesEpisodeHistory(
      { tmdbId: 101, mediaType: "TV" },
      { tmdbId: 101, mediaType: "TV" },
    );

    assert.equal(preserve, true);
    assert.deepEqual(planEpisodeEventRelinks(preserve, events, freshEpisodes), [
      { eventId: "event-1", episodeId: "fresh-s1e1" },
      { eventId: "event-2", episodeId: "fresh-s1e2" },
    ]);
  });

  it("keeps different-show events detached instead of transplanting their links", () => {
    const preserve = preservesEpisodeHistory(
      { tmdbId: 101, mediaType: "TV" },
      { tmdbId: 202, mediaType: "TV" },
    );

    assert.equal(preserve, false);
    assert.deepEqual(planEpisodeEventRelinks(preserve, events, freshEpisodes), []);
  });

  it("keeps old TV episode events detached when the title becomes a movie", () => {
    const preserve = preservesEpisodeHistory(
      { tmdbId: 101, mediaType: "TV" },
      { tmdbId: 303, mediaType: "MOVIE" },
    );

    assert.equal(preserve, false);
    assert.deepEqual(planEpisodeEventRelinks(preserve, events, freshEpisodes), []);
  });

  it("does not guess a link when a same-show episode disappears from TMDB", () => {
    assert.deepEqual(planEpisodeEventRelinks(true, events, freshEpisodes), [
      { eventId: "event-1", episodeId: "fresh-s1e1" },
      { eventId: "event-2", episodeId: "fresh-s1e2" },
    ]);
  });

  it("moves an event with its TMDB episode when TMDB renumbers it", () => {
    const renumbered = [
      { episodeId: "special", tmdbId: 100, seasonNumber: 1, episodeNumber: 1, withdrawn: false },
      { episodeId: "pilot", tmdbId: 101, seasonNumber: 1, episodeNumber: 2, withdrawn: false },
      { episodeId: "second", tmdbId: 102, seasonNumber: 1, episodeNumber: 3, withdrawn: false },
    ];

    assert.deepEqual(planEpisodeEventRelinks(true, events, renumbered), [
      { eventId: "event-1", episodeId: "pilot" },
      { eventId: "event-2", episodeId: "second" },
    ]);
  });

  it("falls back to coordinates only for legacy events without a TMDB id", () => {
    assert.deepEqual(
      planEpisodeEventRelinks(
        true,
        [{ eventId: "legacy", tmdbId: null, seasonNumber: 1, episodeNumber: 1, withdrawn: false }],
        [{ episodeId: "fresh", tmdbId: 999, seasonNumber: 1, episodeNumber: 1, withdrawn: false }],
      ),
      [{ eventId: "legacy", episodeId: "fresh" }],
    );
  });
  // review-p2-sync.md, issue 2: a legacy row (no TMDB id) that was already
  // withdrawn, whose number TMDB has since given to a new episode.
  it("keeps an already-withdrawn legacy row's history on its recreated row", () => {
    const withdrawnEvent = {
      eventId: "history",
      tmdbId: null,
      seasonNumber: 1,
      episodeNumber: 7,
      withdrawn: true,
    };
    const fresh = [
      { episodeId: "new-s1e7", tmdbId: 7777, seasonNumber: 1, episodeNumber: 7, withdrawn: false },
      { episodeId: "kept-s1e7", tmdbId: null, seasonNumber: 1, episodeNumber: 2_000_007, withdrawn: true },
    ];
    assert.deepEqual(planEpisodeEventRelinks(true, [withdrawnEvent], fresh), [
      { eventId: "history", episodeId: "kept-s1e7" },
    ]);

    // With its number still free, the row is recreated where it was.
    assert.deepEqual(
      planEpisodeEventRelinks(true, [withdrawnEvent], [
        { episodeId: "kept-s1e7", tmdbId: null, seasonNumber: 1, episodeNumber: 7, withdrawn: true },
      ]),
      [{ eventId: "history", episodeId: "kept-s1e7" }],
    );
    // A row already in the reserved range stays there.
    assert.deepEqual(
      planEpisodeEventRelinks(true, [{ ...withdrawnEvent, episodeNumber: 2_000_007 }], fresh),
      [{ eventId: "history", episodeId: "kept-s1e7" }],
    );
  });

  it("leaves a withdrawn legacy event detached when its row wasn't recreated", () => {
    // An unwatched withdrawn row isn't recreated; the new episode must not
    // inherit its history.
    assert.deepEqual(
      planEpisodeEventRelinks(
        true,
        [{ eventId: "history", tmdbId: null, seasonNumber: 1, episodeNumber: 7, withdrawn: true }],
        [{ episodeId: "new-s1e7", tmdbId: 7777, seasonNumber: 1, episodeNumber: 7, withdrawn: false }],
      ),
      [],
    );
  });
});

describe("relink batching", () => {
  it("splits into ordered slices with a short tail", () => {
    assert.deepEqual(chunks([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunks([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
    assert.deepEqual(chunks([], 2), []);
  });

  it("keeps a relink statement inside Postgres' bind limit", () => {
    // Two binds per relink, plus one for the titleId predicate.
    assert.ok(RELINK_BATCH_SIZE * 2 + 1 <= 65_535);
    const relinks = Array.from({ length: RELINK_BATCH_SIZE + 1 }, (_, index) => index);
    assert.deepEqual(
      chunks(relinks, RELINK_BATCH_SIZE).map((batch) => batch.length),
      [RELINK_BATCH_SIZE, 1],
    );
  });
});

describe("tvRuntime", () => {
  const season = (...runtimes: Array<number | null>) => ({
    id: 1,
    season_number: 1,
    name: "Season 1",
    overview: "",
    air_date: null,
    poster_path: null,
    episodes: runtimes.map((runtime, index) => ({
      id: 100 + index,
      episode_number: index + 1,
      season_number: 1,
      name: `Episode ${index + 1}`,
      overview: "",
      air_date: null,
      runtime,
      still_path: null,
      vote_average: 0,
    })),
  });

  it("prefers the runtime TMDB states", () => {
    assert.equal(tvRuntime([42, 50], [season(60)]), 42);
  });

  it("falls back to the median episode runtime, ignoring zero and missing ones", () => {
    assert.equal(tvRuntime([], [season(58, 90, null), season(60, 0)]), 60);
    assert.equal(tvRuntime([0], [season(58, 61)]), 60);
    assert.equal(tvRuntime(undefined, [season(58, 90, 60, 62)]), 61);
  });

  it("returns null when neither TMDB nor the episodes state one", () => {
    assert.equal(tvRuntime([], [season(null, 0)]), null);
    assert.equal(tvRuntime(null, []), null);
  });
});
