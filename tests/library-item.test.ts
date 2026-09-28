import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CardItem } from "../src/components/title-card";
import type { MediaType, WatchStatus } from "../src/generated/prisma/client";
import { toLibraryItem, type LibraryItem, type LibraryItemRow } from "../src/lib/data";
import { year } from "../src/lib/format";

// Compile-time half, checked by `tsc --noEmit` (which covers tests/): the
// trimmed item still renders as a card. The filters, sorts and list rows are
// typed against LibraryItem directly, so a field they read that the type
// loses fails the type check there.
const asCard = (item: LibraryItem): CardItem => item;

const row: LibraryItemRow = {
  id: "t1",
  name: "Station Eleven",
  mediaType: "TV" as MediaType,
  tmdbId: 90802,
  posterPath: "/abc.jpg",
  releaseDate: new Date("2021-12-16T00:00:00Z"),
  language: "en",
  tmdbRating: 7.9,
  status: "WATCHED" as WatchStatus,
  rating: 8,
  favorite: true,
  totalEpisodes: 10,
  watchedEpisodes: 10,
  genres: ["Drama"],
  watchedAt: new Date("2025-02-01T20:15:00.123Z"),
  createdAt: new Date("2025-01-05T09:00:00.456Z"),
  streamProviderIds: [15],
  providersRegion: "US",
  providersSyncedAt: new Date("2026-09-26T07:00:00Z"),
  tags: [{ tag: { name: "rewatch" } }],
};

// VE-05: every title rides the library's page payload, so it carries only the
// fields the cards, list rows, filters and sorts read.
describe("library items (VE-05)", () => {
  it("sends exactly the fields the library reads", () => {
    assert.deepEqual(Object.keys(toLibraryItem(row, false)).sort(), [
      "createdAt",
      "favorite",
      "genres",
      "hasNewEpisodes",
      "id",
      "language",
      "mediaType",
      "name",
      "posterPath",
      "providersRegion",
      "providersSyncedAt",
      "rating",
      "releaseDate",
      "status",
      "streamProviderIds",
      "tags",
      "tmdbId",
      "tmdbRating",
      "totalEpisodes",
      "watchedAt",
      "watchedEpisodes",
    ]);
  });

  it("sends the release date as a calendar date the year is read from", () => {
    const item = toLibraryItem(row, true);
    assert.equal(item.releaseDate, "2021-12-16");
    assert.equal(year(item.releaseDate), "2021");
    assert.equal(toLibraryItem({ ...row, releaseDate: null }, false).releaseDate, null);
    // The date sort compares these strings, which order like the dates.
    assert.ok("1999-12-31" < "2000-01-01" && "2021-02-03" < "2021-11-30");
  });

  it("keeps full timestamps and flattens tags", () => {
    const item = toLibraryItem(row, true);
    assert.equal(item.watchedAt, "2025-02-01T20:15:00.123Z");
    assert.equal(item.createdAt, "2025-01-05T09:00:00.456Z");
    assert.equal(item.providersSyncedAt, "2026-09-26T07:00:00.000Z");
    assert.deepEqual(item.tags, ["rewatch"]);
    assert.equal(item.hasNewEpisodes, true);
    assert.equal(asCard(item).id, "t1");
  });
});
