import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  planEpisodeEventRelinks,
  preservesEpisodeHistory,
} from "../src/lib/rematch-history";

const events = [
  { eventId: "event-1", seasonNumber: 1, episodeNumber: 1 },
  { eventId: "event-2", seasonNumber: 1, episodeNumber: 2 },
  { eventId: "event-3", seasonNumber: 2, episodeNumber: 1 },
];

const freshEpisodes = [
  { episodeId: "fresh-s1e1", seasonNumber: 1, episodeNumber: 1 },
  { episodeId: "fresh-s1e2", seasonNumber: 1, episodeNumber: 2 },
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
});
