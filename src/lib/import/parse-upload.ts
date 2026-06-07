import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import type { ParsedStatus, ParsedTitle } from "./parse-excel";

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as unknown as Record<string, unknown>;
    if (typeof o.text === "string") return o.text.trim() || null;
    if ("result" in o) return cellText(o.result as ExcelJS.CellValue);
    if (Array.isArray(o.richText)) {
      return (
        (o.richText as { text?: string }[]).map((r) => r.text ?? "").join("").trim() ||
        null
      );
    }
  }
  return String(v).trim() || null;
}

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function mapStatus(text: string | null): ParsedStatus {
  const s = (text ?? "").toLowerCase();
  if (s.includes("partial") || s.includes("watching") || s.includes("progress"))
    return "PARTIALLY_WATCHED";
  if (
    s.includes("watched") ||
    s.includes("seen") ||
    s.includes("complete") ||
    s.includes("finished")
  )
    return "WATCHED";
  return "UNWATCHED";
}

function mapType(text: string | null): "movie" | "tv" {
  const s = (text ?? "").toLowerCase();
  if (s.includes("tv") || s.includes("show") || s.includes("series") || s.includes("season"))
    return "tv";
  return "movie";
}

function yearToIso(text: string | null): string | null {
  if (!text) return null;
  const m = text.match(/(\d{4})/);
  return m ? `${m[1]}-01-01` : null;
}

export interface UploadParseResult {
  titles: ParsedTitle[];
  error?: string;
}

/**
 * Parse a user-uploaded .xlsx/.csv into ParsedTitle[]. Expects a header row
 * with at least a Title/Name column; Year, Type, and Status are optional.
 */
export async function parseUploadedList(
  buffer: Buffer,
  filename: string,
): Promise<UploadParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    if (filename.toLowerCase().endsWith(".csv")) {
      await wb.csv.read(Readable.from([buffer]));
    } else {
      // Cast bridges the Node Buffer<ArrayBufferLike> vs exceljs Buffer typing.
      await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    }
  } catch {
    return { titles: [], error: "Couldn't read that file. Upload a .xlsx or .csv." };
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 1) return { titles: [], error: "The file looks empty." };

  const headers: Record<string, number> = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = normHeader(cellText(cell.value) ?? "");
    if (h) headers[h] = col;
  });
  const find = (...names: string[]): number | null => {
    for (const n of names) if (headers[n] != null) return headers[n];
    return null;
  };

  const nameCol = find(
    "name",
    "title",
    "moviename",
    "tvshowname",
    "movietitle",
    "showname",
    "movie",
    "show",
  );
  if (nameCol == null) {
    return {
      titles: [],
      error:
        'No "Title" or "Name" column found in the first row. Add a header row with at least a Title column.',
    };
  }
  const yearCol = find("year", "releaseyear", "dateofrelease", "released", "release", "date");
  const typeCol = find("type", "mediatype", "category", "kind");
  const statusCol = find("status", "watched", "state");

  const titles: ParsedTitle[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const name = cellText(row.getCell(nameCol).value);
    if (!name) continue;
    const releaseText = yearCol ? cellText(row.getCell(yearCol).value) : null;
    titles.push({
      source: "upload",
      mediaType: typeCol ? mapType(cellText(row.getCell(typeCol).value)) : "movie",
      name,
      releaseDateText: releaseText,
      releaseDate: yearToIso(releaseText),
      status: statusCol ? mapStatus(cellText(row.getCell(statusCol).value)) : "UNWATCHED",
      languageHint: null,
    });
  }

  return { titles };
}
