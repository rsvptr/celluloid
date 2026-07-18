import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus } from "../src/lib/import/run-import";
import { parseHumanDate } from "../src/lib/import/parse-excel";
import { WatchStatus } from "../src/generated/prisma/client";

describe("deriveStatus", () => {
  it("passes DROPPED / ON_HOLD through untouched, whatever the counts", () => {
    assert.equal(deriveStatus(WatchStatus.DROPPED, 0, 10), WatchStatus.DROPPED);
    assert.equal(deriveStatus(WatchStatus.DROPPED, 10, 10), WatchStatus.DROPPED);
    assert.equal(deriveStatus(WatchStatus.ON_HOLD, 3, 10), WatchStatus.ON_HOLD);
    assert.equal(deriveStatus(WatchStatus.ON_HOLD, 10, 10), WatchStatus.ON_HOLD);
  });

  it("is WATCHED once every episode is watched (total > 0)", () => {
    assert.equal(deriveStatus(WatchStatus.WATCHLIST, 10, 10), WatchStatus.WATCHED);
    // watched can exceed total (counter drift after episodes are removed) —
    // still complete.
    assert.equal(deriveStatus(WatchStatus.WATCHING, 12, 10), WatchStatus.WATCHED);
  });

  it("is WATCHING when some but not all episodes are watched", () => {
    assert.equal(deriveStatus(WatchStatus.WATCHLIST, 3, 10), WatchStatus.WATCHING);
    // Even if the imported base said WATCHED, partial progress downgrades it.
    assert.equal(deriveStatus(WatchStatus.WATCHED, 1, 10), WatchStatus.WATCHING);
    // Total unknown (0) but progress recorded → in progress, not complete.
    assert.equal(deriveStatus(WatchStatus.WATCHLIST, 5, 0), WatchStatus.WATCHING);
  });

  it("keeps the imported base status when nothing is watched", () => {
    assert.equal(deriveStatus(WatchStatus.WATCHLIST, 0, 10), WatchStatus.WATCHLIST);
    // A "watching" show whose per-episode progress is unknown stays WATCHING.
    assert.equal(deriveStatus(WatchStatus.WATCHING, 0, 0), WatchStatus.WATCHING);
    assert.equal(deriveStatus(WatchStatus.WATCHING, 0, 10), WatchStatus.WATCHING);
  });
});

describe("parseHumanDate", () => {
  it("returns an already-ISO date unchanged (no timezone shift)", () => {
    // Regression for the D5 bug: a canonical yyyy-mm-dd (what cellText emits for
    // a real Excel Date cell) must round-trip, not be re-parsed as UTC midnight
    // and shifted back a day by local getters in timezones behind UTC.
    assert.equal(parseHumanDate("2004-04-23"), "2004-04-23");
    assert.equal(parseHumanDate("2020-01-01"), "2020-01-01");
    assert.equal(parseHumanDate("  2019-12-31  "), "2019-12-31");
  });

  it("parses a human 'Month D, YYYY' string to the right local date", () => {
    assert.equal(parseHumanDate("April 23, 2004"), "2004-04-23");
    assert.equal(parseHumanDate("December 31, 2019"), "2019-12-31");
  });

  it("returns null for blank, sentinel, or unparseable input", () => {
    assert.equal(parseHumanDate(null), null);
    assert.equal(parseHumanDate(""), null);
    assert.equal(parseHumanDate("TBD"), null);
    assert.equal(parseHumanDate("N/A"), null);
    assert.equal(parseHumanDate("not a date"), null);
  });
});
