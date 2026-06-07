import ExcelJS from "exceljs";
import type { ExportRow } from "./format";

interface Col {
  header: string;
  width: number;
  value: (r: ExportRow, i: number) => string | number | null;
}

const COMMON: Col[] = [
  { header: "SI. No.", width: 8, value: (_r, i) => i + 1 },
  { header: "Name", width: 38, value: (r) => r.name },
  { header: "Release Date", width: 16, value: (r) => r.releaseDate ?? "" },
  { header: "Language", width: 14, value: (r) => (r.languageCode ? r.language : "") },
  { header: "Status", width: 16, value: (r) => r.status },
  { header: "My Rating", width: 10, value: (r) => (r.myRating != null ? r.myRating : "") },
  { header: "TMDB", width: 8, value: (r) => (r.tmdbRating != null ? r.tmdbRating : "") },
  { header: "Genres", width: 28, value: (r) => r.genres.join(", ") },
  { header: "Favorite", width: 10, value: (r) => (r.favorite ? "Yes" : "") },
  { header: "Tags", width: 20, value: (r) => r.tags.join(", ") },
  { header: "Notes", width: 40, value: (r) => r.notes ?? "" },
];

const TV_EXTRA: Col[] = [
  {
    header: "Progress",
    width: 16,
    value: (r) =>
      r.totalEpisodes ? `${r.watchedEpisodes}/${r.totalEpisodes} eps` : "",
  },
];

function addSheet(
  wb: ExcelJS.Workbook,
  name: string,
  rows: ExportRow[],
  cols: Col[],
) {
  const ws = wb.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  ws.columns = cols.map((c) => ({ header: c.header, width: c.width }));

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FF04121C" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF2DD4EE" },
  };
  header.alignment = { vertical: "middle" };
  header.height = 20;

  rows.forEach((r, i) => {
    ws.addRow(cols.map((c) => c.value(r, i)));
  });

  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: cols.length },
  };
}

export async function buildWorkbookBuffer(rows: ExportRow[]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Celluloid";
  wb.created = new Date();

  const movies = rows.filter((r) => r.mediaType === "movie");
  const tv = rows.filter((r) => r.mediaType === "tv");

  // Insert TV progress column after Status for the TV sheet.
  const tvCols: Col[] = [
    ...COMMON.slice(0, 5),
    ...TV_EXTRA,
    ...COMMON.slice(5),
  ];

  if (movies.length || !tv.length) addSheet(wb, "Movies", movies, COMMON);
  if (tv.length) addSheet(wb, "TV Shows", tv, tvCols);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
