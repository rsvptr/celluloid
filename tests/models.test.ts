import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_REC_MODEL,
  MODEL_CACHE_MIN_TOKENS,
  MODEL_CAPS,
  REC_ERAS,
  REC_MODELS,
  eraById,
  isRecEra,
  isRecModel,
  knownRecModel,
  resolveRecModel,
} from "../src/lib/models";

describe("recommendation models", () => {
  it("defaults new recommendation runs to Sonnet", () => {
    assert.equal(DEFAULT_REC_MODEL, "claude-sonnet-5");
  });

  it("offers Opus 5.5, Sonnet 5 and Haiku 4.5, and no longer Opus 5", () => {
    assert.deepEqual(
      REC_MODELS.map((m) => [m.id, m.label]),
      [
        ["claude-opus-5-5", "Claude Opus 5.5"],
        ["claude-sonnet-5", "Claude Sonnet 5"],
        ["claude-haiku-4-5", "Claude Haiku 4.5"],
      ],
    );
    assert.equal(isRecModel("claude-opus-5"), false);
  });

  it("accepts known ids and rejects junk", () => {
    assert.equal(isRecModel(DEFAULT_REC_MODEL), true);
    assert.equal(isRecModel("gpt-9000"), false);
    assert.equal(isRecModel(null), false);
  });

  it("has capability entries for every model", () => {
    for (const m of REC_MODELS) {
      assert.ok(MODEL_CAPS[m.id], `missing MODEL_CAPS for ${m.id}`);
      assert.ok(MODEL_CACHE_MIN_TOKENS[m.id], `missing MODEL_CACHE_MIN_TOKENS for ${m.id}`);
    }
  });

  it("uses each model's documented minimum cacheable prefix", () => {
    assert.deepEqual(MODEL_CACHE_MIN_TOKENS, {
      "claude-opus-5-5": 512,
      "claude-sonnet-5": 1024,
      "claude-haiku-4-5": 4096,
    });
  });
});

describe("stored model ids", () => {
  it("keeps a current id as it is", () => {
    for (const m of REC_MODELS) assert.equal(resolveRecModel(m.id), m.id);
  });

  it("moves a saved Opus 5 preference to Opus 5.5", () => {
    assert.equal(knownRecModel("claude-opus-5"), "claude-opus-5-5");
    assert.equal(resolveRecModel("claude-opus-5"), "claude-opus-5-5");
  });

  it("treats an id the lineup never offered as unknown, even in a known family", () => {
    for (const id of ["claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
      assert.equal(knownRecModel(id), null, id);
    }
  });

  it("falls back to the default for a missing or unknown id", () => {
    for (const id of [
      null,
      undefined,
      "",
      "gpt-9000",
      "claude-fable-5-1",
      "claude-opus-4-8",
      "__proto__",
      "constructor",
      "claude-",
    ]) {
      assert.equal(knownRecModel(id), null, String(id));
      assert.equal(resolveRecModel(id), DEFAULT_REC_MODEL, String(id));
    }
  });

  // The route and the engine are covered in recommend-stream.test.ts.
  it("resolves the saved model before it reaches the picker", async () => {
    const page = await readFile(
      new URL("../src/app/(app)/recommend/page.tsx", import.meta.url),
      "utf8",
    );
    assert.match(page, /model=\{resolveRecModel\(info\.recommendModel\)\}/);
  });
});

describe("eras", () => {
  it("accepts known era ids and rejects junk", () => {
    assert.equal(isRecEra("1990s"), true);
    assert.equal(isRecEra("3020s"), false);
    assert.equal(isRecEra(undefined), false);
  });

  it("era ranges are coherent decade bounds", () => {
    for (const e of REC_ERAS) {
      const [from, to] = e.range;
      assert.ok(from < to, `${e.id} range inverted`);
    }
    assert.deepEqual([...eraById("1990s").range], [1990, 1999]);
    assert.equal(eraById("pre-1970").range[1], 1969);
  });
});
