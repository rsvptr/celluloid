import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_REC_MODEL,
  MODEL_CAPS,
  REC_ERAS,
  REC_MODELS,
  eraById,
  isRecEra,
  isRecModel,
} from "../src/lib/models";

describe("recommendation models", () => {
  it("accepts known ids and rejects junk", () => {
    assert.equal(isRecModel(DEFAULT_REC_MODEL), true);
    assert.equal(isRecModel("gpt-9000"), false);
    assert.equal(isRecModel(null), false);
  });

  it("has capability entries for every model", () => {
    for (const m of REC_MODELS) {
      assert.ok(MODEL_CAPS[m.id], `missing MODEL_CAPS for ${m.id}`);
    }
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
