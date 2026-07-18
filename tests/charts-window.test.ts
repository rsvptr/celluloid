import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { windowActivity } from "../src/components/charts";

// Fixed "today" so the window is deterministic regardless of when the test
// runs. 2026-07-17 is a Friday; the grid's last column ends on the following
// Saturday (2026-07-18).
const TODAY = new Date("2026-07-17T12:00:00.000Z");

describe("windowActivity", () => {
  it("excludes a high-count day outside the visible window from total and max", () => {
    // Way outside a 4-week window: should not inflate total or flatten the
    // color scale via max.
    const ancientSpike = { date: "2020-01-01", count: 500 };
    // Inside the window.
    const recentDay = { date: "2026-07-15", count: 3 };

    const { total, max, cols } = windowActivity([ancientSpike, recentDay], 4, TODAY);

    assert.equal(total, 3);
    assert.equal(max, 3);
    // The out-of-window date must not appear anywhere in the rendered grid.
    const allDates = cols.flat().map((c) => c.date);
    assert.ok(!allDates.includes("2020-01-01"));
    assert.ok(allDates.includes("2026-07-15"));
  });

  it("computes total and max only from days inside the window when both in- and out-of-window data exist", () => {
    const activity = [
      { date: "2019-06-01", count: 999 }, // far outside
      { date: "2026-07-10", count: 2 },
      { date: "2026-07-12", count: 5 },
    ];
    const { total, max } = windowActivity(activity, 4, TODAY);
    assert.equal(total, 7); // 2 + 5, excluding the 999 spike
    assert.equal(max, 5);
  });

  it("returns max of 1 (not 0) when the window has no activity", () => {
    const { total, max } = windowActivity([], 4, TODAY);
    assert.equal(total, 0);
    assert.equal(max, 1);
  });

  it("lays out `weeks` columns of 7 days each, ending on the upcoming Saturday", () => {
    const { cols } = windowActivity([], 3, TODAY);
    assert.equal(cols.length, 3);
    for (const col of cols) assert.equal(col.length, 7);
    const lastCol = cols[cols.length - 1];
    assert.equal(lastCol[lastCol.length - 1].date, "2026-07-18");
  });

  it("marks days after today as future", () => {
    const { cols } = windowActivity([], 1, TODAY);
    const flat = cols.flat();
    const todayCell = flat.find((c) => c.date === "2026-07-17");
    const tomorrowCell = flat.find((c) => c.date === "2026-07-18");
    assert.equal(todayCell?.future, false);
    assert.equal(tomorrowCell?.future, true);
  });

  it("counts a day at the exact window boundary (inclusive start and end)", () => {
    const { cols } = windowActivity(
      [
        { date: "2026-06-21", count: 1 }, // start of a 4-week window ending 2026-07-18
        { date: "2026-07-18", count: 1 }, // end of window
      ],
      4,
      TODAY,
    );
    const flat = cols.flat();
    assert.equal(flat[0].date, "2026-06-21");
    assert.equal(flat[0].count, 1);
    assert.equal(flat[flat.length - 1].date, "2026-07-18");
    assert.equal(flat[flat.length - 1].count, 1);
  });
});
