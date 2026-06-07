import ExcelJS from "exceljs";

/** Normalized watch status used across import + DB. */
export type ParsedStatus = "WATCHED" | "PARTIALLY_WATCHED" | "UNWATCHED";

export interface ParsedTvMeta {
  finalSeasonText: string | null;
  totalSeasonsText: string | null;
  totalSeasons: number | null;
  releasedPendingText: string | null;
  releasedSeasons: number | null;
}

export interface ParsedTitle {
  source: string; // "Movies" | "TV Shows" | "Malayalam" | "upload" | ...
  mediaType: "movie" | "tv";
  name: string;
  releaseDateText: string | null;
  /** ISO yyyy-mm-dd, or null if unparseable (e.g. "TBD"). */
  releaseDate: string | null;
  status: ParsedStatus;
  /** ISO-639-1 hint derived from the source sheet (e.g. "ml"), else null. */
  languageHint: string | null;
  tv?: ParsedTvMeta;
}

function cellText(value: ExcelJS.CellValue | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  // Rich text / hyperlink / formula objects
  if (typeof value === "object") {
    const v = value as unknown as Record<string, unknown>;
    if ("text" in v && typeof v.text === "string") return v.text.trim() || null;
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v && Array.isArray(v.richText)) {
      return (
        (v.richText as { text?: string }[])
          .map((r) => r.text ?? "")
          .join("")
          .trim() || null
      );
    }
  }
  return String(value).trim() || null;
}

const NO_DATE = new Set(["tbd", "n/a", "na", "unknown", "-", "—"]);

/** Parse a human date like "April 23, 2004" into ISO yyyy-mm-dd (local components, no TZ shift). */
export function parseHumanDate(text: string | null): string | null {
  if (!text) return null;
  const cleaned = text.trim();
  if (!cleaned || NO_DATE.has(cleaned.toLowerCase())) return null;
  const d = new Date(cleaned);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeStatus(text: string | null): ParsedStatus {
  const s = (text ?? "").toLowerCase();
  if (s.includes("partial")) return "PARTIALLY_WATCHED";
  if (s.includes("unwatch")) return "UNWATCHED";
  if (s.includes("watch")) return "WATCHED";
  return "UNWATCHED";
}

function firstInt(text: string | null): number | null {
  if (!text) return null;
  const m = text.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function parseReleasedSeasons(text: string | null, total: number | null): number | null {
  if (!text) return null;
  const s = text.toLowerCase();
  // "all aired" cases: prefer the known total, else a sentinel meaning "all".
  const all = total ?? Number.POSITIVE_INFINITY;
  if (s.includes("all released")) return all;
  // "1 Released, 1 Pending" → 1
  const m = s.match(/(\d+)\s*released/);
  if (m) return parseInt(m[1], 10);
  // "Canceled After Pilot Season" → 1 season aired
  if (s.includes("pilot")) return 1;
  // "Canceled After Second Season" etc. → all aired seasons were released
  if (s.includes("cancel")) return all;
  return null;
}

/**
 * Parse the legacy "Movies & TV Shows Watched" workbook into normalized titles.
 * Sheets: "Movies" (movie), "TV Shows" (tv), "Malayalam" (movie, language hint ml).
 */
export async function parseWatchedWorkbook(filePath: string): Promise<ParsedTitle[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);

  const out: ParsedTitle[] = [];

  for (const ws of wb.worksheets) {
    const sheet = ws.name.trim();
    const isTv = sheet.toLowerCase().includes("tv");
    const isMalayalam = sheet.toLowerCase().includes("malayalam");
    const source = (isTv ? "TV Shows" : isMalayalam ? "Malayalam" : "Movies") as ParsedTitle["source"];

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // header
      const name = cellText(row.getCell(2).value);
      if (!name) return; // skip blank rows

      const releaseDateText = cellText(row.getCell(3).value);
      const releaseDate = parseHumanDate(releaseDateText);

      if (isTv) {
        const finalSeasonText = cellText(row.getCell(4).value);
        const totalSeasonsText = cellText(row.getCell(5).value);
        const releasedPendingText = cellText(row.getCell(6).value);
        const status = normalizeStatus(cellText(row.getCell(7).value));
        const totalSeasons = firstInt(totalSeasonsText);
        out.push({
          source,
          mediaType: "tv",
          name,
          releaseDateText,
          releaseDate,
          status,
          languageHint: null,
          tv: {
            finalSeasonText,
            totalSeasonsText,
            totalSeasons,
            releasedPendingText,
            releasedSeasons: parseReleasedSeasons(releasedPendingText, totalSeasons),
          },
        });
      } else {
        const status = normalizeStatus(cellText(row.getCell(4).value));
        out.push({
          source,
          mediaType: "movie",
          name,
          releaseDateText,
          releaseDate,
          status,
          languageHint: isMalayalam ? "ml" : null,
        });
      }
    });
  }

  return out;
}
