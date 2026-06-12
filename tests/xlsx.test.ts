import { describe, it } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildWorkbookBuffer } from "../src/lib/export/xlsx";
import type { ExportRow } from "../src/lib/export/format";

function row(over: Partial<ExportRow>): ExportRow {
  return {
    id: "x",
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
});
