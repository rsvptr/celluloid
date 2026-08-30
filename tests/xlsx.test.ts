import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildWorkbookBuffer } from "../src/lib/export/xlsx";
import type { ExportRow } from "../src/lib/export/format";
import { parseUploadedList } from "../src/lib/import/parse-upload";

function row(over: Partial<ExportRow>): ExportRow {
  return {
    id: "x",
    tmdbId: 101,
    name: "Placeholder",
    mediaType: "movie",
    year: 2020,
    releaseDate: "2020-01-01",
    languageCode: "en",
    language: "English",
    statusKey: "WATCHED",
    status: "Watched",
    myRating: 8,
    tmdbRating: 7.2,
    genres: ["Drama"],
    totalEpisodes: null,
    watchedEpisodes: 0,
    watchCount: 0,
    favorite: true,
    notes: "great",
    tags: ["gem"],
    watchedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// Also serves as a regression check that the uuid override (security fix)
// leaves exceljs's write path working: exceljs requires uuid at import time.
describe("buildWorkbookBuffer", () => {
  it("writes a workbook that reads back with the right sheets and data", async () => {
    const rows = [
      row({ name: "Heat", mediaType: "movie", year: 1995 }),
      row({ name: "Severance", mediaType: "tv", totalEpisodes: 18, watchedEpisodes: 9 }),
    ];
    const buf = await buildWorkbookBuffer(rows);
    assert.ok(buf.length > 1000, "buffer should be a real xlsx");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

    const movies = wb.getWorksheet("Movies");
    const tv = wb.getWorksheet("TV Shows");
    assert.ok(movies, "Movies sheet exists");
    assert.ok(tv, "TV Shows sheet exists");

    // Row 1 is the header; the first data row carries the movie name.
    assert.equal(movies!.getRow(2).getCell(2).value, "Heat");
    assert.equal(tv!.getRow(2).getCell(2).value, "Severance");
    // The TV sheet's inserted Progress column sits after Status.
    assert.equal(tv!.getRow(1).getCell(6).value, "Progress");
    assert.equal(tv!.getRow(2).getCell(6).value, "9/18 eps");
  });

  it("emits a Movies sheet even for an empty export", async () => {
    const buf = await buildWorkbookBuffer([]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    assert.ok(wb.getWorksheet("Movies"));
  });

  it("adds Date Watched and Times Watched columns right after My Rating", async () => {
    const rows = [
      row({ name: "Rewatched", watchedAt: "2024-01-12T00:00:00.000Z", watchCount: 4 }),
      row({ name: "Never Logged", watchedAt: null, watchCount: 0 }),
    ];
    const buf = await buildWorkbookBuffer(rows);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const movies = wb.getWorksheet("Movies")!;

    // Columns: SI.No, Name, Release Date, Language, Status, My Rating, then
    // the two new ones — cells 7 and 8.
    assert.equal(movies.getRow(1).getCell(7).value, "Date Watched");
    assert.equal(movies.getRow(1).getCell(8).value, "Times Watched");

    // watchedAt is a full ISO timestamp upstream; the cell shows a plain date.
    assert.equal(movies.getRow(2).getCell(7).value, "2024-01-12");
    assert.equal(movies.getRow(2).getCell(8).value, 4);

    // Neither logged: blank cells, not 0 / empty-string artifacts.
    assert.equal(movies.getRow(3).getCell(7).value, "");
    assert.equal(movies.getRow(3).getCell(8).value, "");
  });

  it("labels TMDB identity separately from the TMDB rating", async () => {
    const buf = await buildWorkbookBuffer([
      row({ tmdbId: 949, tmdbRating: 8.2, name: "Heat" }),
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const movies = wb.getWorksheet("Movies")!;

    assert.equal(movies.getRow(1).getCell(9).value, "TMDB ID");
    assert.equal(movies.getRow(2).getCell(9).value, 949);
    assert.equal(movies.getRow(1).getCell(10).value, "TMDB Rating");
    assert.equal(movies.getRow(2).getCell(10).value, 8.2);
  });

  it("re-imports both Celluloid sheets with exact TMDB identities", async () => {
    const buf = await buildWorkbookBuffer([
      row({
        tmdbId: 949,
        name: "Heat",
        mediaType: "movie",
        releaseDate: "1995-12-15",
        myRating: 9,
      }),
      row({
        tmdbId: 95396,
        name: "Severance",
        mediaType: "tv",
        releaseDate: "2022-02-18",
        totalEpisodes: 18,
        watchedEpisodes: 9,
      }),
    ]);

    const parsed = await parseUploadedList(Buffer.from(buf), "celluloid-library.xlsx");

    assert.equal(parsed.error, undefined);
    assert.deepEqual(
      parsed.titles.map((title) => ({
        name: title.name,
        mediaType: title.mediaType,
        releaseDate: title.releaseDate,
        rating: title.rating,
        tmdbId: title.tmdbId,
      })),
      [
        {
          name: "Heat",
          mediaType: "movie",
          releaseDate: "1995-01-01",
          rating: 9,
          tmdbId: 949,
        },
        {
          name: "Severance",
          mediaType: "tv",
          releaseDate: "2022-01-01",
          rating: 8,
          tmdbId: 95396,
        },
      ],
    );
  });
});
