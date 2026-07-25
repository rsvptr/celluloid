import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeStreaks, dayKeyInZone, resolveTimeZone } from "../src/lib/data";

// Day keys are what getStats' SQL bucketing produces: owner-local "YYYY-MM-DD".
const days = (...keys: string[]) => keys;

describe("dayKeyInZone", () => {
  it("buckets an instant into the owner's calendar day, not the server's", () => {
    // 00:30 UTC on March 1 is still 19:30 on February 28 in New York.
    assert.equal(
      dayKeyInZone(new Date("2026-03-01T00:30:00Z"), "America/New_York"),
      "2026-02-28",
    );
    assert.equal(
      dayKeyInZone(new Date("2026-03-01T00:30:00Z"), "UTC"),
      "2026-03-01",
    );
  });

  it("pads single-digit months and days", () => {
    assert.equal(dayKeyInZone(new Date("2026-01-05T12:00:00Z"), "UTC"), "2026-01-05");
  });

  it("falls back to UTC on a zone Intl rejects instead of throwing", () => {
    assert.equal(
      dayKeyInZone(new Date("2026-03-01T00:30:00Z"), "Mars/Olympus_Mons"),
      "2026-03-01",
    );
    assert.equal(dayKeyInZone(new Date("2026-03-01T00:30:00Z"), ""), "2026-03-01");
  });
});

describe("resolveTimeZone", () => {
  it("keeps a real IANA zone", () => {
    assert.equal(resolveTimeZone("America/New_York"), "America/New_York");
    assert.equal(resolveTimeZone("Asia/Kolkata"), "Asia/Kolkata");
    assert.equal(resolveTimeZone("Etc/GMT+5"), "Etc/GMT+5");
  });

  it("degrades to UTC for anything Postgres would reject or read differently", () => {
    assert.equal(resolveTimeZone(""), "UTC");
    assert.equal(resolveTimeZone("Mars/Olympus_Mons"), "UTC");
    // Intl accepts offset identifiers; Postgres reads their sign the other way.
    assert.equal(resolveTimeZone("+05:30"), "UTC");
    assert.equal(resolveTimeZone("'; DROP TABLE \"Title\"; --"), "UTC");
  });
});

describe("computeStreaks", () => {
  it("reports nothing for a library with no activity", () => {
    assert.deepEqual(computeStreaks([], "2026-07-24"), {
      currentStreak: 0,
      longestStreak: 0,
    });
  });

  it("counts a single active day today", () => {
    assert.deepEqual(computeStreaks(days("2026-07-24"), "2026-07-24"), {
      currentStreak: 1,
      longestStreak: 1,
    });
  });

  it("counts a single active day yesterday — today is still in progress", () => {
    assert.deepEqual(computeStreaks(days("2026-07-23"), "2026-07-24"), {
      currentStreak: 1,
      longestStreak: 1,
    });
  });

  it("drops the current streak once two days have passed", () => {
    assert.deepEqual(computeStreaks(days("2026-07-22"), "2026-07-24"), {
      currentStreak: 0,
      longestStreak: 1,
    });
  });

  it("counts a contiguous run ending today", () => {
    assert.deepEqual(
      computeStreaks(
        days("2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24"),
        "2026-07-24",
      ),
      { currentStreak: 4, longestStreak: 4 },
    );
  });

  it("breaks the run on a one-day gap", () => {
    assert.deepEqual(
      computeStreaks(
        days("2026-07-20", "2026-07-21", "2026-07-23", "2026-07-24"),
        "2026-07-24",
      ),
      { currentStreak: 2, longestStreak: 2 },
    );
  });

  it("keeps the longest run even when the current one is shorter", () => {
    assert.deepEqual(
      computeStreaks(
        days(
          "2026-06-01",
          "2026-06-02",
          "2026-06-03",
          "2026-06-04",
          "2026-06-05",
          "2026-07-23",
          "2026-07-24",
        ),
        "2026-07-24",
      ),
      { currentStreak: 2, longestStreak: 5 },
    );
  });

  it("does not depend on the order the keys arrive in", () => {
    assert.deepEqual(
      computeStreaks(days("2026-07-24", "2026-07-22", "2026-07-23"), "2026-07-24"),
      { currentStreak: 3, longestStreak: 3 },
    );
  });

  it("survives a month boundary", () => {
    assert.deepEqual(
      computeStreaks(days("2026-06-29", "2026-06-30", "2026-07-01"), "2026-07-01"),
      { currentStreak: 3, longestStreak: 3 },
    );
  });

  it("holds a run across a spring-forward DST transition", () => {
    // America/New_York moves to EDT at 02:00 on 2026-03-08, so these four
    // 22:00-local instants are not all 24h apart in UTC. Bucketing them in the
    // owner's zone still yields four consecutive calendar days.
    const nightly = [
      "2026-03-07T03:00:00Z", // Mar 6, 22:00 EST
      "2026-03-08T03:00:00Z", // Mar 7, 22:00 EST
      "2026-03-09T02:00:00Z", // Mar 8, 22:00 EDT (only 23h after the previous)
      "2026-03-10T02:00:00Z", // Mar 9, 22:00 EDT
    ].map((iso) => dayKeyInZone(new Date(iso), "America/New_York"));

    assert.deepEqual(nightly, [
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
    assert.deepEqual(computeStreaks(nightly, "2026-03-09"), {
      currentStreak: 4,
      longestStreak: 4,
    });
  });

  it("holds a run across a fall-back DST transition", () => {
    // 2026-11-01: the day is 25 hours long in New York.
    const nightly = [
      "2026-11-01T01:30:00Z", // Oct 31, 21:30 EDT
      "2026-11-02T02:30:00Z", // Nov 1, 21:30 EST
      "2026-11-03T02:30:00Z", // Nov 2, 21:30 EST
    ].map((iso) => dayKeyInZone(new Date(iso), "America/New_York"));

    assert.deepEqual(nightly, ["2026-10-31", "2026-11-01", "2026-11-02"]);
    assert.deepEqual(computeStreaks(nightly, "2026-11-02"), {
      currentStreak: 3,
      longestStreak: 3,
    });
  });
});
