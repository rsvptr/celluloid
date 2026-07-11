import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRecExtractor } from "../src/lib/rec-stream";

const REC_A = { title: "Kumbalangi Nights", year: 2019, mediaType: "movie" };
const REC_B = { title: "Dark", year: 2017, mediaType: "tv" };

describe("createRecExtractor", () => {
  it("extracts items from a complete payload in one push", () => {
    const ex = createRecExtractor();
    const got = ex.push(JSON.stringify({ recommendations: [REC_A, REC_B] }));
    assert.deepEqual(got, [REC_A, REC_B]);
  });

  it("extracts items as their closing brace arrives across chunks", () => {
    const ex = createRecExtractor();
    const full = JSON.stringify({ recommendations: [REC_A, REC_B] });
    const cut = full.indexOf("},") + 1; // just past the first item
    const first = ex.push(full.slice(0, cut));
    assert.deepEqual(first, [REC_A]);
    const second = ex.push(full.slice(cut));
    assert.deepEqual(second, [REC_B]);
  });

  it("survives single-character chunking", () => {
    const ex = createRecExtractor();
    const full = JSON.stringify({ recommendations: [REC_A, REC_B] });
    const got: unknown[] = [];
    for (const ch of full) got.push(...ex.push(ch));
    assert.deepEqual(got, [REC_A, REC_B]);
  });

  it("is not confused by braces and escaped quotes inside strings", () => {
    const tricky = {
      title: 'The "{Weird}" One: [a] \\ story',
      year: null,
      mediaType: "movie",
      reason: "Braces {inside} strings, and an escaped quote: \" done",
    };
    const ex = createRecExtractor();
    const full = JSON.stringify({ recommendations: [tricky, REC_A] });
    const got: unknown[] = [];
    // chunk at awkward 3-char boundaries
    for (let i = 0; i < full.length; i += 3) got.push(...ex.push(full.slice(i, i + 3)));
    assert.deepEqual(got, [tricky, REC_A]);
  });

  it("handles nested objects/arrays inside an item", () => {
    const nested = { title: "X", meta: { tags: ["a", "b"], inner: { d: 1 } } };
    const ex = createRecExtractor();
    const got = ex.push(JSON.stringify({ recommendations: [nested] }));
    assert.deepEqual(got, [nested]);
  });

  it("returns nothing for an empty recommendations array", () => {
    const ex = createRecExtractor();
    assert.deepEqual(ex.push('{"recommendations":[]}'), []);
  });

  it("skips a malformed slice without dying", () => {
    const ex = createRecExtractor();
    // Hand-build a stream where the first "object" is invalid JSON.
    const got = [
      ...ex.push('{"recommendations":[{bad json}'),
      ...ex.push(","),
      ...ex.push(JSON.stringify(REC_B)),
      ...ex.push("]}"),
    ];
    assert.deepEqual(got, [REC_B]);
  });
});
