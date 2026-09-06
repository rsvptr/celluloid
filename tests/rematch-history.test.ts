import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planEpisodeEventRelinks,
  preservesEpisodeHistory,
} from "../src/lib/rematch-history";

const events = [
  { eventId: "event-1", tmdbId: 101, seasonNumber: 1, episodeNumber: 1 },
  { eventId: "event-2", tmdbId: 102, seasonNumber: 1, episodeNumber: 2 },
  { eventId: "event-3", tmdbId: null, seasonNumber: 2, episodeNumber: 1 },
];

const freshEpisodes = [
  { episodeId: "fresh-s1e1", tmdbId: 101, seasonNumber: 1, episodeNumber: 1 },
  { episodeId: "fresh-s1e2", tmdbId: 102, seasonNumber: 1, episodeNumber: 2 },
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
      { episodeId: "special", tmdbId: 100, seasonNumber: 1, episodeNumber: 1 },
      { episodeId: "pilot", tmdbId: 101, seasonNumber: 1, episodeNumber: 2 },
      { episodeId: "second", tmdbId: 102, seasonNumber: 1, episodeNumber: 3 },
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
        [{ eventId: "legacy", tmdbId: null, seasonNumber: 1, episodeNumber: 1 }],
        [{ episodeId: "fresh", tmdbId: 999, seasonNumber: 1, episodeNumber: 1 }],
      ),
      [{ eventId: "legacy", episodeId: "fresh" }],
    );
  });
});
