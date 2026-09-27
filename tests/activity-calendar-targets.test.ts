import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityCalendar } from "../src/app/(app)/stats/activity-calendar";

const html = renderToStaticMarkup(
  createElement(ActivityCalendar, {
    activity: [{ date: "2026-09-20", count: 2 }],
    days: [],
    todayKey: "2026-09-27",
  }),
);

function classesOf(tag: string): string[][] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*class="([^"]*)"`, "g"))].map(
    ([, c]) => c.split(" "),
  );
}

// JK-10: 11px day cells with 3px gaps fail WCAG 2.5.8 on touch. Below sm, a
// 20px cell with a 4px gap puts centers 24px apart (the spacing exception);
// from sm the compact grid is unchanged.
describe("activity calendar day targets (JK-10)", () => {
  const cells = classesOf("button").filter((c) => c.includes("focus-ring"));

  it("renders a year of day cells", () => {
    assert.ok(cells.length >= 7 * 52);
  });

  it("sizes each cell 20px below sm and 11px from sm", () => {
    for (const c of cells) {
      assert.ok(c.includes("size-5"), c.join(" "));
      assert.ok(c.includes("sm:size-[11px]"), c.join(" "));
    }
  });

  it("spaces rows and columns 4px below sm and 3px from sm", () => {
    const grid = classesOf("div").filter((c) => c.includes("sm:gap-[3px]"));
    // The week row plus one column per week.
    assert.ok(grid.length >= 53);
    for (const c of grid) assert.ok(c.includes("gap-1"), c.join(" "));
  });
});

// The 20px grid is wider than a phone, so it opens on the current week, not
// the oldest (JK-10 follow-on).
describe("activity calendar scroll position", () => {
  it("scrolls the grid to its end on mount", async () => {
    const src = await readFile(
      new URL("../src/app/(app)/stats/activity-calendar.tsx", import.meta.url),
      "utf8",
    );
    assert.match(src, /<div ref=\{scrollerRef\} className="overflow-x-auto pb-1">/);
    assert.match(
      src,
      /useLayoutEffect\(\(\) => \{\s*const el = scrollerRef\.current;\s*if \(el\) el\.scrollLeft = el\.scrollWidth;\s*\}, \[\]\);/,
    );
  });
});
