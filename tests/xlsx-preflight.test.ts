import { describe, it } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import ExcelJS from "exceljs";
import { preflightXlsxZip, parseUploadedList } from "../src/lib/import/parse-upload";

/**
 * Hand-build a ZIP purely from bytes so tests can control the *declared* sizes
 * independently of the physical payload — that is exactly how a decompression
 * bomb lies. Emits real local-file-header + central-directory + EOCD records so
 * offsets are consistent with the buffer the preflight walks.
 */
interface ZipEntry {
  name: string;
  data: Buffer; // bytes physically stored (already deflated when method === 8)
  method?: number; // 0 = store, 8 = deflate (default 0)
  declaredUncompressed?: number; // central/local uncompressed size (default data.length)
  declaredCompressed?: number; // central/local compressed size (default data.length)
}

function makeZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0; // running offset of the next local header

  for (const e of entries) {
    const method = e.method ?? 0;
    const nameBuf = Buffer.from(e.name, "utf8");
    const compSize = e.declaredCompressed ?? e.data.length;
    const uncompSize = e.declaredUncompressed ?? e.data.length;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0, 6); // flags
    lfh.writeUInt16LE(method, 8);
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0, 12); // mod date
    lfh.writeUInt32LE(0, 14); // crc (unread by the preflight)
    lfh.writeUInt32LE(compSize >>> 0, 18);
    lfh.writeUInt32LE(uncompSize >>> 0, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    localParts.push(lfh, nameBuf, e.data);

    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // central directory header signature
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0, 8); // flags
    cdh.writeUInt16LE(method, 10);
    cdh.writeUInt16LE(0, 12); // mod time
    cdh.writeUInt16LE(0, 14); // mod date
    cdh.writeUInt32LE(0, 16); // crc
    cdh.writeUInt32LE(compSize >>> 0, 20);
    cdh.writeUInt32LE(uncompSize >>> 0, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra length
    cdh.writeUInt16LE(0, 32); // comment length
    cdh.writeUInt16LE(0, 34); // disk number
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset >>> 0, 42); // relative offset of local header
    centralParts.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + e.data.length;
  }

  const central = Buffer.concat(centralParts);
  const cdStart = offset;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length & 0xffff, 8); // records this disk
  eocd.writeUInt16LE(entries.length & 0xffff, 10); // total records
  eocd.writeUInt32LE(central.length >>> 0, 12); // central dir size
  eocd.writeUInt32LE(cdStart >>> 0, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, eocd]);
}

describe("preflightXlsxZip", () => {
  it("accepts a small, well-formed zip", () => {
    const lines: string[] = [];
    for (let i = 0; i < 30; i++) lines.push(`Movie ${i},${2000 + i},Movie,Watched`);
    const content = Buffer.from(lines.join("\n"), "utf8");
    const deflated = zlib.deflateRawSync(content);
    const zip = makeZip([
      {
        name: "sheet.xml",
        data: deflated,
        method: 8,
        declaredUncompressed: content.length,
        declaredCompressed: deflated.length,
      },
      { name: "meta.txt", data: Buffer.from("plain stored bytes"), method: 0 },
    ]);
    assert.equal(preflightXlsxZip(zip).ok, true);
  });

  it("rejects a deflated-zeros bomb declaring ~50MB uncompressed", () => {
    // Tiny physical payload, headers that claim a 50 MB expansion.
    const deflated = zlib.deflateRawSync(Buffer.alloc(256 * 1024));
    const zip = makeZip([
      {
        name: "bomb.bin",
        data: deflated,
        method: 8,
        declaredUncompressed: 50 * 1024 * 1024,
        declaredCompressed: deflated.length,
      },
    ]);
    assert.equal(preflightXlsxZip(zip).ok, false);
  });

  it("rejects a high compression ratio even when sizes are under the caps", () => {
    // 1 MB of zeros (< 10 MB entry cap, < 20 MB total cap) deflates to ~1 KB,
    // a ~1000x ratio, so only the ratio guard should trip.
    const deflated = zlib.deflateRawSync(Buffer.alloc(1024 * 1024));
    const zip = makeZip([
      {
        name: "ratio.bin",
        data: deflated,
        method: 8,
        declaredUncompressed: 1024 * 1024,
        declaredCompressed: deflated.length,
      },
    ]);
    const r = preflightXlsxZip(zip);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ratio");
  });

  it("rejects a single entry over the per-entry size cap", () => {
    // 12 MB declared (> 10 MB entry cap) but < 20 MB total and ratio 1, so only
    // the per-entry guard should trip.
    const zip = makeZip([
      {
        name: "big.bin",
        data: Buffer.from("x"),
        declaredUncompressed: 12 * 1024 * 1024,
        declaredCompressed: 12 * 1024 * 1024,
      },
    ]);
    const r = preflightXlsxZip(zip);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "entry-too-large");
  });

  it("rejects an archive with too many entries", () => {
    const entries: ZipEntry[] = Array.from({ length: 201 }, (_v, i) => ({
      name: `f${i}`,
      data: Buffer.alloc(0),
    }));
    const r = preflightXlsxZip(makeZip(entries));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too-many-entries");
  });

  it("rejects a ZIP64 archive (sentinel central-directory offset)", () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("hello") }]);
    // Overwrite the EOCD central-directory-offset field with the ZIP64 sentinel.
    zip.writeUInt32LE(0xffffffff, zip.length - 22 + 16);
    const r = preflightXlsxZip(zip);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "zip64");
  });

  it("rejects an out-of-range central directory", () => {
    const zip = makeZip([{ name: "a", data: Buffer.from("hello") }]);
    // Point the central-directory offset past the end of the buffer.
    zip.writeUInt32LE(zip.length, zip.length - 22 + 16);
    const r = preflightXlsxZip(zip);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "central-directory-out-of-range");
  });

  it("rejects truncated or non-zip buffers", () => {
    assert.equal(preflightXlsxZip(Buffer.from("not a zip, just text ".repeat(20))).ok, false);
    assert.equal(preflightXlsxZip(Buffer.alloc(8)).ok, false); // shorter than an EOCD
    const valid = makeZip([{ name: "a", data: Buffer.from("hello world") }]);
    // Chop off the whole EOCD so no record can be located.
    assert.equal(preflightXlsxZip(valid.subarray(0, valid.length - 30)).ok, false);
  });

  it("passes a genuine exceljs workbook and still parses it end-to-end", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(["Title", "Year", "Type", "Status"]);
    ws.addRow(["Dune", 2021, "Movie", "Watched"]);
    ws.addRow(["Severance", 2022, "TV Show", "Partially Watched"]);
    const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    // A real workbook is a real ZIP: it must clear the preflight...
    assert.equal(preflightXlsxZip(buf).ok, true);

    // ...and still parse cleanly through the actual upload parser.
    const { titles, error } = await parseUploadedList(buf, "list.xlsx");
    assert.equal(error, undefined);
    assert.equal(titles.length, 2);
    assert.equal(titles[0].name, "Dune");
    assert.equal(titles[0].mediaType, "movie");
    assert.equal(titles[0].status, "WATCHED");
    assert.equal(titles[1].name, "Severance");
    assert.equal(titles[1].mediaType, "tv");
    assert.equal(titles[1].status, "PARTIALLY_WATCHED");
  });
});
