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

  it("errors clearly when there is no title column", async () => {
    const buf = csv(["Foo,Bar", "x,y"]);
    const { titles, error } = await parseUploadedList(buf, "list.csv");
    assert.equal(titles.length, 0);
    assert.ok(error?.includes('No "Title" or "Name" column'));
  });
});
