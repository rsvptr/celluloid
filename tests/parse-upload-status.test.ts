import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseUploadedList } from "../src/lib/import/parse-upload";

function csv(lines: string[]): Buffer {
  return Buffer.from(lines.join("\n"), "utf8");
}

describe("uploaded list status parsing", () => {
  it("reads negated status words as unwatched, not watched", async () => {
    // Every negative form here contains a positive token as a substring
    // ("Unwatched" ⊃ "watched", "unseen" ⊃ "seen", "incomplete" ⊃ "complete"),
    // so a positive-first substring check silently marked them all WATCHED.
    const result = await parseUploadedList(
      csv([
        "Title,Type,Status",
        "A,Movie,Unwatched",
        "B,Movie,Not Watched",
        "C,Movie,unseen",
        "D,Movie,incomplete",
        "E,Movie,haven't watched yet",
        "F,Movie,never watched",
      ]),
      "list.csv",
    );
    assert.equal(result.error, undefined);
    assert.equal(result.titles.length, 6);
    for (const t of result.titles) {
      assert.equal(t.status, "UNWATCHED", `${t.name} ("${t.status}") should be UNWATCHED`);
    }
  });

  it("still reads genuine positive and partial forms as before", async () => {
    const result = await parseUploadedList(
      csv([
        "Title,Type,Status",
        "A,Movie,Watched",
        "B,Movie,Seen",
        "C,Movie,Completed",
        "D,Movie,finished",
        "E,TV,Watching",
        "F,TV,In progress",
        "G,Movie,",
        "H,Movie,Plan to watch",
      ]),
      "list.csv",
    );
    assert.equal(result.error, undefined);
    const byName = Object.fromEntries(result.titles.map((t) => [t.name, t.status]));
    assert.equal(byName.A, "WATCHED");
    assert.equal(byName.B, "WATCHED");
    assert.equal(byName.C, "WATCHED");
    assert.equal(byName.D, "WATCHED");
    assert.equal(byName.E, "PARTIALLY_WATCHED");
    assert.equal(byName.F, "PARTIALLY_WATCHED");
    assert.equal(byName.G, "UNWATCHED");
    // "Plan to watch" has no past-tense token, so it lands on the watchlist.
    assert.equal(byName.H, "UNWATCHED");
  });
});

describe("parseHumanDate day-first handling", () => {
  it("reads slashed numeric dates day-first", async () => {
    const { parseHumanDate } = await import("../src/lib/import/parse-excel");
    // Rejected outright before: month 23 does not exist, so the date was lost.
    assert.equal(parseHumanDate("23/04/2004"), "2004-04-23");
    // Silently swapped before: read as March 4th.
    assert.equal(parseHumanDate("03/04/2026"), "2026-04-03");
    // Dots and two-digit years follow the same rule.
    assert.equal(parseHumanDate("3.4.26"), "2026-04-03");
  });

  it("rejects impossible combinations instead of rolling them over", async () => {
    const { parseHumanDate } = await import("../src/lib/import/parse-excel");
    assert.equal(parseHumanDate("31/02/2024"), null);
    assert.equal(parseHumanDate("00/05/2024"), null);
  });

  it("leaves canonical ISO and prose dates on their existing paths", async () => {
    const { parseHumanDate } = await import("../src/lib/import/parse-excel");
    assert.equal(parseHumanDate("2024-05-06"), "2024-05-06");
    assert.equal(parseHumanDate("April 23, 2004"), "2004-04-23");
    assert.equal(parseHumanDate("tbd"), null);
  });
});
