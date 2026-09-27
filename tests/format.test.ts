import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  airedAgoText,
  formatCount,
  fullDate,
  languageName,
  nameWithTypeAndYear,
  progressPct,
  runtimeText,
  tvStatusLabel,
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

describe("airedAgoText (JK-18)", () => {
  const today = "2026-09-27";
  it("counts days, then weeks, for recent episodes", () => {
    assert.equal(airedAgoText(today, today), "aired today");
    assert.equal(airedAgoText("2026-09-26", today), "aired yesterday");
    assert.equal(airedAgoText("2026-09-14", today), "aired 13 days ago");
    assert.equal(airedAgoText("2026-09-13", today), "aired 2 weeks ago");
    assert.equal(airedAgoText("2026-08-03", today), "aired 7 weeks ago");
  });
  it("gives the date once it is 8 weeks or more back", () => {
    assert.equal(airedAgoText("2026-08-02", today), "aired Aug 2, 2026");
    // The audit's "22082 days ago" row.
    assert.equal(airedAgoText("1966-03-18", today), "aired Mar 18, 1966");
  });
});

describe("tvStatusLabel (JK-32)", () => {
  it("softens TMDB's lifecycle strings into sentence case", () => {
    assert.equal(tvStatusLabel("Returning Series"), "Returning");
    assert.equal(tvStatusLabel("Canceled"), "Cancelled");
    assert.equal(tvStatusLabel("In Production"), "In production");
    assert.equal(tvStatusLabel("Ended"), "Ended");
  });
});

describe("nameWithTypeAndYear (JK-21)", () => {
  it("tells a show from a same-named movie", () => {
    assert.equal(nameWithTypeAndYear("The Long, Hot Summer", "tv", "1965"), "The Long, Hot Summer (TV, 1965)");
    assert.equal(nameWithTypeAndYear("The Long, Hot Summer", "movie", 1958), "The Long, Hot Summer (Movie, 1958)");
  });
  it("drops a missing year", () => {
    assert.equal(nameWithTypeAndYear("Untitled", "movie", ""), "Untitled (Movie)");
    assert.equal(nameWithTypeAndYear("Untitled", "tv", null), "Untitled (TV)");
  });
});

describe("formatCount (JK-28)", () => {
  it("groups digits", () => {
    assert.equal(formatCount(12345), "12,345");
    assert.equal(formatCount(7), "7");
  });
});
