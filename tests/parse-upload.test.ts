import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUploadedList } from "../src/lib/import/parse-upload";

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf8");
}

describe("parseUploadedList (csv)", () => {
  it("maps title, year, type, and status columns", async () => {
    const buf = csv([
      "Title,Year,Type,Status",
      "Dune,2021,Movie,Watched",
      "Severance,2022,TV Show,Partially Watched",
    ]);
    const { titles, error } = await parseUploadedList(buf, "list.csv");
    assert.equal(error, undefined);
    assert.equal(titles.length, 2);

    assert.equal(titles[0].name, "Dune");
    assert.equal(titles[0].mediaType, "movie");
    assert.equal(titles[0].releaseDate, "2021-01-01");
    assert.equal(titles[0].status, "WATCHED");

    assert.equal(titles[1].name, "Severance");
    assert.equal(titles[1].mediaType, "tv");
    assert.equal(titles[1].status, "PARTIALLY_WATCHED");
  });

  it("defaults missing type and status, skips blank names", async () => {
    const buf = csv(["Title,Year", "Heat,1995", ",1999", "Alien,"]);
    const { titles } = await parseUploadedList(buf, "list.csv");
    assert.equal(titles.length, 2);
    assert.equal(titles[0].mediaType, "movie");
    assert.equal(titles[0].status, "UNWATCHED");
    assert.equal(titles[1].name, "Alien");
    assert.equal(titles[1].releaseDate, null);
  });

  it("reads a Trakt-style tvdb_id column as the row's TVDB id (TM-12)", async () => {
    const buf = csv(["title,year,type,tvdb_id", "Friends,1994,show,79168", "Dune,2021,movie,"]);
    const { titles } = await parseUploadedList(buf, "list.csv");
    assert.equal(titles[0].tvdbId, 79168);
    assert.equal(titles[1].tvdbId, null);
  });

  it("errors clearly when there is no title column", async () => {
    const buf = csv(["Foo,Bar", "x,y"]);
    const { titles, error } = await parseUploadedList(buf, "list.csv");
    assert.equal(titles.length, 0);
    assert.ok(error?.includes('No "Title" or "Name" column'));
  });
});

describe("parseUploadedList — inferring a file's own conventions", () => {
  // Letterboxd ships watchlist.csv and watched.csv with IDENTICAL headers
  // (`Date,Name,Year,Letterboxd URI`), where Date means "added to the watchlist"
  // in one and "watched on" in the other. Reading the first as the second would
  // convert an entire watchlist into fabricated watch history — the one piece of
  // information (that these are UNWATCHED) that nothing else could reconstruct.
  it("does not treat a bare Date column as evidence of watching", async () => {
    const buf = csv([
      "Date,Name,Year,Letterboxd URI",
      "2024-03-01,Sinners,2025,https://boxd.it/aaa",
      "2024-03-02,Nosferatu,2024,https://boxd.it/bbb",
    ]);
    const { titles, error } = await parseUploadedList(buf, "watchlist.csv");

    assert.equal(error, undefined);
    assert.equal(titles.length, 2);
    for (const t of titles) {
      assert.notEqual(t.status, "WATCHED", `${t.name} must not be marked watched`);
      assert.ok(!t.watchedAt, `${t.name} must not carry a fabricated watch date`);
    }
    // The year column is still read, so the rows remain matchable.
    assert.equal(titles[0].releaseDate, "2025-01-01");
  });

  it("does treat an explicitly named viewing column as evidence of watching", async () => {
    const buf = csv([
      "Name,Year,Watched Date",
      "Sinners,2025,2024-03-01",
    ]);
    const { titles } = await parseUploadedList(buf, "watched.csv");

    assert.equal(titles[0].status, "WATCHED");
    assert.equal(titles[0].watchedAt, "2024-03-01");
  });

  // The scales are only distinguishable one way round: a value above 5 proves a
  // 0-10 column, but everything at or below 5 is genuinely ambiguous (a 0-10
  // file can happen to contain only low scores). Guessing wrong silently halves
  // or doubles every rating, so the ambiguous case imports no rating at all.
  it("rescues a bare Rating column only when a value proves the 0-10 scale", async () => {
    const proven = await parseUploadedList(
      csv(["Title,Year,Rating", "Heat,1995,9", "Alien,1979,4"]),
      "list.csv",
    );
    assert.equal(proven.titles[0].rating, 9, "9 proves the column is 0-10");
    assert.equal(proven.titles[1].rating, 4, "and the whole column follows");

    const ambiguous = await parseUploadedList(
      csv(["Title,Year,Rating", "Heat,1995,4", "Alien,1979,3.5"]),
      "list.csv",
    );
    assert.ok(
      ambiguous.titles[0].rating == null,
      "an undecidable scale imports no rating rather than guessing one",
    );
    assert.ok(
      ambiguous.titles[0].ratingText,
      "the unimported value is kept so review can explain the omission",
    );
  });

  it("reports the assumptions it made so review can surface them", async () => {
    const { notes } = await parseUploadedList(
      csv(["Date,Name,Year", "2024-03-01,Sinners,2025"]),
      "watchlist.csv",
    );
    assert.ok(Array.isArray(notes) && notes.length > 0);
  });
});
