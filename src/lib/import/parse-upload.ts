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
}

/**
 * Parse a user-uploaded .xlsx/.csv into ParsedTitle[]. Expects a header row
 * with at least a Title/Name column; Year, Type, and Status are optional.
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

  // Cap row iteration so a small but massively-inflated file can't force us to
  // scan an enormous materialized sheet. Read a little past maxRows so the
  // caller can still tell the file was truncated (titles.length > maxRows).
  const lastRow =
    maxRows != null ? Math.min(ws.rowCount, maxRows + ROW_SCAN_BUFFER) : ws.rowCount;
  const scanCapped = lastRow < ws.rowCount;
  const titles: ParsedTitle[] = [];
  for (let r = 2; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const rawName = cellText(row.getCell(nameCol).value);
    if (!rawName) continue;
    const rawReleaseText = yearCol ? cellText(row.getCell(yearCol).value) : null;
    // Slice to the staging read-schema's bounds (parsedTitleSchema in
    // import-staging-format.ts: name max 500, releaseDateText max 200) so an
    // oversized cell fails here instead of getting staged and then 500ing
    // every subsequent read of the job.
    const name = rawName.slice(0, 500);
    const releaseText = rawReleaseText ? rawReleaseText.slice(0, 200) : rawReleaseText;
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

  return {
    titles,
    totalRows: scanCapped ? undefined : Math.max(0, ws.rowCount - 1),
    scanCapped,
  };
}
