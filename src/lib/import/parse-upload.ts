import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { parseHumanDate, type ParsedStatus, type ParsedTitle } from "./parse-excel";

/**
 * Serialize a date cell to yyyy-mm-dd without moving the day. exceljs puts date
 * cells on midnight, but which midnight depends on the reader: the xlsx reader
 * lands on UTC midnight, the CSV reader on LOCAL midnight. Formatting both with
 * toISOString() shifted every CSV date back a day anywhere east of Greenwich,
 * which was enough to read a 1 January release as the previous year — and now
 * that a sheet's watch dates are imported, to record the wrong day for them.
 * Take the components of whichever midnight the value actually sits on, and
 * fall back to UTC only when the cell carries a real time of day.
 */
function dateToIsoDay(value: Date): string {
  const utcMidnight =
    value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0;
  const localMidnight =
    value.getHours() === 0 && value.getMinutes() === 0 && value.getSeconds() === 0;
  if (utcMidnight || !localMidnight) return value.toISOString().slice(0, 10);
  const yyyy = value.getFullYear();
  const mm = String(value.getMonth() + 1).padStart(2, "0");
  const dd = String(value.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function cellText(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return dateToIsoDay(v);
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
  // Negative forms must be ruled out before the positive tokens, because each
  // one CONTAINS its positive counterpart as a substring: "Unwatched" ⊃
  // "watched", "unseen" ⊃ "seen", "incomplete" ⊃ "complete". The trailing
  // space on the free-standing negators keeps words like "notable" out.
  if (
    s.includes("unwatch") ||
    s.includes("unseen") ||
    s.includes("unfinished") ||
    s.includes("incomplete") ||
    s.includes("not ") ||
    s.includes("never ") ||
    s.includes("n't ")
  )
    return "UNWATCHED";
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

/**
 * Which scale a rating column is on, decided from its HEADING first. A heading
 * that names its scale settles it; otherwise the values get one narrow say (see
 * resolveScaleFromValues), because guessing wrong doubles or halves every score
 * in the library. "unknown" means a rating column exists but nothing proved
 * which scale it is on, so its values are read as text and dropped instead of
 * being converted on a guess.
 */
type RatingScale = "five" | "ten" | "unknown";

/** Headings that name the 0-5 scale outright. A bare "Rating" is deliberately
 * NOT one of them: Letterboxd writes 0.5-5 under it but plenty of hand-made
 * sheets mean 1-10, and doubling one of those turned a 7 into a 14 that clipped
 * to a flat 10. It falls through to the values instead. */
const FIVE_SCALE_HEADERS = ["stars", "starrating", "ratingoutof5", "rating5"];
/** IMDb exports rate 1-10 under "Your Rating"; Trakt and Celluloid use 10 too. */
const TEN_SCALE_HEADERS = [
  "yourrating",
  "myrating",
  "ratingoutof10",
  "rating10",
  "imdbrating",
  "traktrating",
];
/** Recognisably a rating, but the heading names no scale. */
const UNKNOWN_SCALE_HEADERS = [
  "rating",
  "userrating",
  "personalrating",
  "score",
];

/**
 * Convert one rating cell to Celluloid's 0.5-10 half-star scale. A 0-5 column is
 * doubled; a 0-10 column is taken as-is. Anything outside the source scale (a
 * stray 11, a negative, an empty or non-numeric cell) yields null rather than a
 * clamped invention, and 0 means "not rated" in both exports.
 */
export function normalizeRating(text: string | null, scale: RatingScale): number | null {
  if (!text || scale === "unknown") return null;
  const value = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  const max = scale === "five" ? 5 : 10;
  if (value > max) return null;
  const scaled = scale === "five" ? value * 2 : value;
  // Snap to the half-star grid the app stores and renders.
  const rounded = Math.round(scaled * 2) / 2;
  return rounded >= 0.5 ? Math.min(10, rounded) : null;
}

/**
 * Last say on a rating column whose heading named no scale: read the values and
 * promote the column to 0-10 only when they prove it. The asymmetry is the whole
 * point — a value above 5 cannot have come from a 0-5 column, so one is proof;
 * but everything sitting at or below 5 proves nothing, because a 0-10 sheet
 * where nothing was rated above 5 looks exactly like a 0-5 one. A value above 10
 * belongs to neither scale (a percentage column, say), so it withdraws the
 * column rather than letting its smaller siblings be read as marks out of 10.
 * Unproven means "unknown": the ratings stay unimported and each row says so,
 * which is the same outcome an unrecognised heading has always had.
 */
function resolveScaleFromValues(
  ws: ExcelJS.Worksheet,
  col: number,
  lastRow: number,
): RatingScale {
  let aboveFive = false;
  for (let r = 2; r <= lastRow; r++) {
    const text = cellText(ws.getRow(r).getCell(col).value);
    if (!text) continue;
    const value = Number(text.trim().replace(",", "."));
    if (!Number.isFinite(value) || value <= 0) continue;
    if (value > 10) return "unknown";
    if (value > 5) aboveFive = true;
  }
  return aboveFive ? "ten" : "unknown";
}

function parseImdbId(text: string | null): string | null {
  if (!text) return null;
  const id = text.trim().toLowerCase();
  return /^tt\d{5,12}$/.test(id) ? id : null;
}

function parseTmdbId(text: string | null): number | null {
  if (!text) return null;
  const id = Number(text.trim());
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Rows scanned past maxRows so the caller can still detect truncation while
 * total work stays bounded (a crafted xlsx can decompress to a huge sheet). */
export const ROW_SCAN_BUFFER = 50;

/** Strip a leading UTF-8 BOM (EF BB BF) so the first header cell isn't read
 * with a leading U+FEFF marker. */
function stripUtf8Bom(buf: Buffer): Buffer {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3);
  }
  return buf;
}

/**
 * Detect a UTF-16 CSV (e.g. a Windows Excel "Unicode Text" export). UTF-16
 * encodes ASCII as a byte plus a 0x00, so its text is ~50% NUL bytes while UTF-8
 * has effectively none; also catch an explicit UTF-16 BOM (FF FE / FE FF).
 * exceljs decodes CSV as UTF-8 only, so importing one would mangle non-ASCII
 * titles — callers should bail with a clear message instead.
 */
function looksUtf16(buf: Buffer): boolean {
  if (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  ) {
    return true;
  }
  const sample = Math.min(buf.length, 1024);
  if (sample === 0) return false;
  let nul = 0;
  for (let i = 0; i < sample; i++) if (buf[i] === 0x00) nul++;
  return nul / sample > 0.2;
}

/**
 * Decompression-bomb ceilings for an uploaded .xlsx (SEC-02). exceljs hands the
 * buffer to JSZip, which inflates every entry with no expanded-size limit, so a
 * tiny crafted archive can balloon to hundreds of MB in memory. We screen the
 * ZIP central directory's *declared* sizes before letting exceljs touch it.
 */
const XLSX_MAX_TOTAL_UNCOMPRESSED = 20 * 1024 * 1024; // 20 MB across all entries
const XLSX_MAX_ENTRY_UNCOMPRESSED = 10 * 1024 * 1024; // 10 MB for any one entry
const XLSX_MAX_ENTRIES = 200; // a real workbook has ~10-15 parts
const XLSX_MAX_RATIO = 120; // total uncompressed / total compressed

// ZIP record signatures (little-endian on disk) and the sentinel values that
// signal a field has overflowed into a ZIP64 record we deliberately don't parse.
const ZIP_EOCD_SIG = 0x06054b50; // End Of Central Directory
const ZIP_CDH_SIG = 0x02014b50; // Central Directory file Header
const ZIP_U16_MAX = 0xffff;
const ZIP_U32_MAX = 0xffffffff;

export type XlsxPreflightReason =
  | "not-a-zip"
  | "zip64"
  | "too-many-entries"
  | "central-directory-out-of-range"
  | "central-directory-corrupt"
  | "entry-too-large"
  | "archive-too-large"
  | "ratio";

export interface XlsxPreflight {
  ok: boolean;
  reason?: XlsxPreflightReason;
}

/**
 * Locate the End-Of-Central-Directory record by scanning backward for its
 * signature. The record sits at the very end of the archive, but a trailing
 * comment (up to 65535 bytes) can push it back, so we scan that window and
 * require the declared comment length to run exactly to end-of-buffer. That
 * both disambiguates the real EOCD from the signature bytes appearing inside
 * file data and rejects truncated/garbage input. Returns -1 when not found.
 */
function findZipEocd(buf: Buffer): number {
  const EOCD_MIN = 22;
  if (buf.length < EOCD_MIN) return -1;
  const scanFloor = Math.max(0, buf.length - EOCD_MIN - ZIP_U16_MAX);
  for (let i = buf.length - EOCD_MIN; i >= scanFloor; i--) {
    if (buf.readUInt32LE(i) !== ZIP_EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + EOCD_MIN + commentLen === buf.length) return i;
  }
  return -1;
}

/**
 * Screen an uploaded .xlsx (a ZIP archive) for decompression-bomb shapes by
 * reading the central directory's declared sizes DIRECTLY from the buffer,
 * before exceljs/JSZip materializes anything. Pure and allocation-free, and it
 * never throws — every buffer read is bounds-checked. ZIP64 archives are
 * rejected outright: their real sizes live in records we don't parse, so a
 * 0xFFFF/0xFFFFFFFF sentinel is treated as over-limit rather than trusted.
 */
export function preflightXlsxZip(buf: Buffer): XlsxPreflight {
  const eocd = findZipEocd(buf);
  if (eocd < 0) return { ok: false, reason: "not-a-zip" };

  const totalEntries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  // A sentinel in any of these means the true value spilled into a ZIP64
  // record; reject rather than parse it.
  if (totalEntries === ZIP_U16_MAX || cdSize === ZIP_U32_MAX || cdOffset === ZIP_U32_MAX) {
    return { ok: false, reason: "zip64" };
  }
  if (totalEntries > XLSX_MAX_ENTRIES) return { ok: false, reason: "too-many-entries" };
  if (cdOffset + cdSize > buf.length) {
    return { ok: false, reason: "central-directory-out-of-range" };
  }

  let totalCompressed = 0;
  let totalUncompressed = 0;
  let p = cdOffset;
  for (let n = 0; n < totalEntries; n++) {
    // Each central-directory header is 46 fixed bytes + name + extra + comment.
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== ZIP_CDH_SIG) {
      return { ok: false, reason: "central-directory-corrupt" };
    }
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);

    // Per-entry ZIP64 sentinel: the real size lives in the extra field we don't
    // parse, so treat it as over-limit.
    if (compSize === ZIP_U32_MAX || uncompSize === ZIP_U32_MAX) {
      return { ok: false, reason: "zip64" };
    }
    if (uncompSize > XLSX_MAX_ENTRY_UNCOMPRESSED) {
      return { ok: false, reason: "entry-too-large" };
    }
    totalCompressed += compSize;
    totalUncompressed += uncompSize;
    if (totalUncompressed > XLSX_MAX_TOTAL_UNCOMPRESSED) {
      return { ok: false, reason: "archive-too-large" };
    }
    p += 46 + nameLen + extraLen + commentLen;
  }

  // Aggregate compression ratio, written as a cross-multiply so a zero
  // compressed total (i.e. output claimed from nothing) still trips the check
  // instead of dividing by zero.
  if (totalUncompressed > XLSX_MAX_RATIO * totalCompressed) {
    return { ok: false, reason: "ratio" };
  }
  return { ok: true };
}

export interface UploadParseResult {
  titles: ParsedTitle[];
  error?: string;
  /** The file's actual data-row count (header excluded), when the scan
   * covered the whole sheet. Undefined when `scanCapped` is true — at that
   * point the sheet's real row count is a lower bound, not a value worth
   * surfacing as exact. */
  totalRows?: number;
  /** True when row scanning stopped at maxRows+buffer before reaching the
   * end of the sheet (the DoS-protection cap below), so `titles` and
   * `totalRows` may undercount the file. */
  scanCapped?: boolean;
  /** What the file left to inference, stated plainly for the review screen. A
   * heading-based guess about a date column or a rating scale is obvious to the
   * owner and invisible in the resulting library, so it has to be said out loud
   * while the import can still be abandoned. Absent when nothing was guessed. */
  notes?: string[];
}

/**
 * Parse a user-uploaded .xlsx/.csv into ParsedTitle[]. Expects a header row
 * with at least a Title/Name column; Year, Type, Status, a rating, a watch
 * date, and an IMDb/TMDB id are all optional. Header matching is
 * case-insensitive and ignores punctuation, so the real column names in a
 * Letterboxd or IMDb export are recognised as they ship.
 */
export async function parseUploadedList(
  buffer: Buffer,
  filename: string,
  maxRows?: number,
): Promise<UploadParseResult> {
  const wb = new ExcelJS.Workbook();
  try {
    if (filename.toLowerCase().endsWith(".csv")) {
      // exceljs decodes CSV as UTF-8 only. Reject a UTF-16 export (which it
      // would mangle) with a clear instruction, and strip a UTF-8 BOM so the
      // first header cell isn't polluted with the marker.
      if (looksUtf16(buffer)) {
        return {
          titles: [],
          error:
            "That CSV looks like UTF-16. Please re-save it as CSV UTF-8 and try again.",
        };
      }
      await wb.csv.read(Readable.from([stripUtf8Bom(buffer)]));
    } else {
      // Screen the ZIP for decompression-bomb shapes before exceljs/JSZip
      // expands any entry (SEC-02). Reuse the parser's invalid-file convention.
      if (!preflightXlsxZip(buffer).ok) {
        return { titles: [], error: "Spreadsheet is too large or malformed." };
      }
      // Cast bridges the Node Buffer<ArrayBufferLike> vs exceljs Buffer typing.
      await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
    }
  } catch {
    return { titles: [], error: "Couldn't read that file. Upload a .xlsx or .csv." };
  }

  const worksheets = wb.worksheets.filter((worksheet) => worksheet.rowCount >= 1);
  if (worksheets.length === 0) return { titles: [], error: "The file looks empty." };

  const titles: ParsedTitle[] = [];
  const notes = new Set<string>();
  const skippedSheets: string[] = [];
  const scanBudget = maxRows == null ? Number.POSITIVE_INFINITY : maxRows + ROW_SCAN_BUFFER;
  let scannedRows = 0;
  let totalRows = 0;
  let scanCapped = false;
  let eligibleSheets = 0;

  // XLSX exports commonly split movies and TV across worksheets (Celluloid's
  // own workbook does). Parse every sheet with a Title/Name header, while one
  // GLOBAL row budget preserves the upload DoS bound across the whole file.
  for (const ws of worksheets) {
    const headers: Record<string, number> = {};
    ws.getRow(1).eachCell((cell, col) => {
      const header = normHeader(cellText(cell.value) ?? "");
      if (header) headers[header] = col;
    });
    const find = (...names: string[]): number | null => {
      for (const name of names) if (headers[name] != null) return headers[name];
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
      skippedSheets.push(ws.name);
      continue;
    }
    eligibleSheets += 1;

    const sheetRows = Math.max(0, ws.rowCount - 1);
    totalRows += sheetRows;
    const availableRows = Math.max(0, scanBudget - scannedRows);
    const rowsToScan = Math.min(sheetRows, availableRows);
    const lastRow = rowsToScan + 1;
    scannedRows += rowsToScan;
    if (rowsToScan < sheetRows) scanCapped = true;

    // "Title Type" is IMDb's own heading ("Movie", "TV Series", "TV Mini Series").
    const typeCol = find("type", "titletype", "mediatype", "category", "kind");
    const sheetName = normHeader(ws.name);
    const defaultMediaType: "movie" | "tv" =
      sheetName.includes("tv") ||
      sheetName.includes("show") ||
      sheetName.includes("series")
        ? "tv"
        : "movie";
    const statusCol = find("status", "watched", "state");

    // A bare "Date" column means different things in different exports: on its
    // own it is the only release hint, but next to a real year it may be a diary
    // or list-added date. Only a heading that names a viewing can mark a row
    // watched; the generic date is used only when status independently says so.
    const releaseYearCol = find(
      "year",
      "releaseyear",
      "releasedate",
      "datereleased",
      "dateofrelease",
      "released",
      "release",
    );
    const watchedCol = find(
      "watcheddate",
      "datewatched",
      "daterated",
      "lastwatched",
      "watchdate",
    );
    const diaryDateCol = watchedCol == null && releaseYearCol != null ? find("date") : null;
    const yearCol = releaseYearCol ?? (watchedCol == null ? find("date") : null);

    const ratingCol =
      find(...FIVE_SCALE_HEADERS) ??
      find(...TEN_SCALE_HEADERS) ??
      find(...UNKNOWN_SCALE_HEADERS);
    const namedScale: RatingScale =
      ratingCol == null
        ? "unknown"
        : FIVE_SCALE_HEADERS.some((header) => headers[header] === ratingCol)
          ? "five"
          : TEN_SCALE_HEADERS.some((header) => headers[header] === ratingCol)
            ? "ten"
            : "unknown";

    // IMDb writes its title id under "Const"; Letterboxd offers "IMDb ID" and
    // "TMDb ID" in its full export. A bare "TMDB" is deliberately NOT an id:
    // Celluloid's older workbook used that heading for the 0-10 TMDB rating.
    const imdbCol = find("const", "imdbid", "imdb");
    const tmdbCol = find("tmdbid", "themoviedbid", "themoviedatabaseid");

    // A heading that named no scale gets one chance from this sheet's values,
    // so every row in that sheet is converted under one stable decision.
    const ratingScale: RatingScale =
      ratingCol == null || namedScale !== "unknown"
        ? namedScale
        : resolveScaleFromValues(ws, ratingCol, lastRow);

    if (statusCol == null && watchedCol != null) {
      notes.add(
        "This file has no status column, so every row with a watch date was read as watched.",
      );
    }
    if (diaryDateCol != null) {
      notes.add(
        'A "Date" column can be when a title was watched or when it was added to a list, so it was not used to mark anything watched on its own.',
      );
    }
    if (ratingCol != null && namedScale === "unknown") {
      notes.add(
        ratingScale === "ten"
          ? "The rating column names no scale. It was read as out of 10, because it holds values above 5."
          : 'The rating column names no scale, so its ratings were not imported. Head it "Stars" for out of 5, or "Your Rating" for out of 10.',
      );
    }

    for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
      const row = ws.getRow(rowNumber);
      const rawName = cellText(row.getCell(nameCol).value);
      if (!rawName) continue;
      const rawReleaseText = yearCol ? cellText(row.getCell(yearCol).value) : null;
      // Slice to the staging read-schema's bounds so an oversized cell fails
      // here instead of poisoning every later read of the persisted job.
      const name = rawName.slice(0, 500);
      const releaseText = rawReleaseText ? rawReleaseText.slice(0, 200) : rawReleaseText;
      const ratingCell = ratingCol ? cellText(row.getCell(ratingCol).value) : null;
      const watchDate = watchedCol
        ? parseHumanDate(cellText(row.getCell(watchedCol).value))
        : null;
      const diaryDate = diaryDateCol
        ? parseHumanDate(cellText(row.getCell(diaryDateCol).value))
        : null;
      const status: ParsedStatus = statusCol
        ? mapStatus(cellText(row.getCell(statusCol).value))
        : watchDate
          ? "WATCHED"
          : "UNWATCHED";
      titles.push({
        source: "upload",
        mediaType: typeCol
          ? mapType(cellText(row.getCell(typeCol).value))
          : defaultMediaType,
        name,
        releaseDateText: releaseText,
        releaseDate: yearToIso(releaseText),
        status,
        languageHint: null,
        rating: normalizeRating(ratingCell, ratingScale),
        ratingText:
          ratingScale === "unknown" && ratingCell ? ratingCell.slice(0, 40) : null,
        watchedAt: watchDate ?? (status === "WATCHED" ? diaryDate : null),
        imdbId: imdbCol ? parseImdbId(cellText(row.getCell(imdbCol).value)) : null,
        tmdbId: tmdbCol ? parseTmdbId(cellText(row.getCell(tmdbCol).value)) : null,
      });
    }
  }

  if (eligibleSheets === 0) {
    return {
      titles: [],
      error:
        'No "Title" or "Name" column found in the first row. Add a header row with at least a Title column.',
    };
  }
  if (skippedSheets.length > 0) {
    notes.add(
      `Skipped ${skippedSheets.length} ${skippedSheets.length === 1 ? "sheet" : "sheets"} without a Title or Name header: ${skippedSheets.join(", ")}.`,
    );
  }

  return {
    titles,
    totalRows: scanCapped ? undefined : totalRows,
    scanCapped,
    ...(notes.size > 0 ? { notes: [...notes] } : {}),
  };
}
