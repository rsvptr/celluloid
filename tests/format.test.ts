import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fullDate,
  languageName,
  progressPct,
  runtimeText,
} from "../src/lib/format";

describe("progressPct", () => {
  it("rounds to whole percent and clamps at 100", () => {
    assert.equal(progressPct(1, 3), 33);
    assert.equal(progressPct(3, 3), 100);
    assert.equal(progressPct(5, 3), 100);
  });
  it("is 0 when the total is missing or zero", () => {
    assert.equal(progressPct(2, 0), 0);
    assert.equal(progressPct(2, null), 0);
  });
});

describe("runtimeText", () => {
  it("formats hours and minutes", () => {
    assert.equal(runtimeText(95), "1h 35m");
    assert.equal(runtimeText(120), "2h");
    assert.equal(runtimeText(45), "45m");
  });
  it("is empty for missing or zero runtime", () => {
    assert.equal(runtimeText(0), "");
    assert.equal(runtimeText(null), "");
  });
});

describe("languageName", () => {
  it("expands ISO codes", () => {
    assert.equal(languageName("ml"), "Malayalam");
    assert.equal(languageName("en"), "English");
  });
  it("says Unknown when missing", () => {
    assert.equal(languageName(null), "Unknown");
  });
});

describe("fullDate", () => {
  it("formats a date in UTC", () => {
    assert.equal(fullDate("2024-02-15"), "February 15, 2024");
  });
  it("says Unknown for missing or invalid input", () => {
    assert.equal(fullDate(null), "Unknown");
    assert.equal(fullDate("not a date"), "Unknown");
  });
});
