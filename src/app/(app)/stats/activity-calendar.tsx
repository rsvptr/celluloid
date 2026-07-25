"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { windowActivity } from "@/components/charts";
import type { ActivityDay } from "@/lib/data";
import { cn } from "@/lib/utils";

// The same five steps as the read-only heatmap in components/charts.tsx, which
// exports its layout maths (windowActivity) but not this scale.
const LEVEL_CLASS = [
  "bg-surface-2",
  "bg-brand/25",
  "bg-brand/45",
  "bg-brand/70",
  "bg-brand",
];

function readableDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * The activity heatmap, with each day selectable. The counts alone raise a
 * question they cannot answer — which titles a busy day was made of — and the
 * watch log already knows, so a cell opens the day underneath the grid.
 *
 * Cells are real buttons, but the grid holds a single tab stop and moves focus
 * with the arrow keys: a year of days would otherwise be a year of tab stops
 * between the chart and the rest of the page.
 */
export function ActivityCalendar({
  activity,
  days,
  weeks = 53,
}: {
  activity: { date: string; count: number }[];
  days: ActivityDay[];
  weeks?: number;
}) {
  const { cols, total, max } = useMemo(
    () => windowActivity(activity, weeks),
    [activity, weeks],
  );
  const detail = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  const countByDate = useMemo(
    () => new Map(cols.flat().map((c) => [c.date, c.count])),
    [cols],
  );
  // The grid runs column by column, one week per column, so a flat pass over it
  // is already in date order: stepping by 1 is the cell above or below, and
  // stepping by 7 is the same weekday one column across.
  const reachable = useMemo(
    () => cols.flat().filter((c) => !c.future).map((c) => c.date),
    [cols],
  );

  const [selected, setSelected] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const cellRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const tabStop = focused ?? reachable[reachable.length - 1] ?? null;

  const moveTo = (index: number) => {
    const date = reachable[Math.max(0, Math.min(reachable.length - 1, index))];
    if (!date) return;
    setFocused(date);
    cellRefs.current.get(date)?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, date: string) => {
    const i = reachable.indexOf(date);
    if (i < 0) return;
    const step: Record<string, number | undefined> = {
      ArrowUp: i - 1,
      ArrowDown: i + 1,
      ArrowLeft: i - 7,
      ArrowRight: i + 7,
      Home: 0,
      End: reachable.length - 1,
    };
    const next = step[e.key];
    if (next === undefined) return;
    e.preventDefault();
    moveTo(next);
  };

  const level = (c: number) => {
    if (c <= 0) return 0;
    const r = c / max;
    if (r > 0.66) return 4;
    if (r > 0.33) return 3;
    return 2;
  };

  const day = selected ? detail.get(selected) : null;
  const selectedCount = selected ? (countByDate.get(selected) ?? 0) : 0;

  return (
    <div>
      <div className="overflow-x-auto pb-1">
        <div className="flex gap-[3px]" role="group" aria-label="Watch activity by day">
          {cols.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {col.map((cell) =>
                cell.future ? (
                  <div key={cell.date} className="h-[11px] w-[11px]" />
                ) : (
                  <button
                    key={cell.date}
                    ref={(el) => {
                      cellRefs.current.set(cell.date, el);
                    }}
                    type="button"
                    tabIndex={cell.date === tabStop ? 0 : -1}
                    aria-pressed={cell.date === selected}
                    aria-label={`${cell.date}: ${cell.count} watched`}
                    title={`${cell.date}: ${cell.count} watched`}
                    onClick={() => {
                      setSelected(cell.date);
                      setFocused(cell.date);
                    }}
                    onKeyDown={(e) => onKeyDown(e, cell.date)}
                    className={cn(
                      "focus-ring h-[11px] w-[11px] rounded-[2px]",
                      LEVEL_CLASS[level(cell.count)],
                      cell.date === selected && "ring-1 ring-foreground",
                    )}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-faint">
        <span>
          <span className="tabular-nums">{total}</span> watched in the last year
        </span>
        <span className="flex items-center gap-1">
          Less
          {LEVEL_CLASS.map((c) => (
            <span key={c} className={cn("h-[10px] w-[10px] rounded-[2px]", c)} />
          ))}
          More
        </span>
      </div>

      <div className="mt-4 border-t border-line pt-3" aria-live="polite">
        {selected === null ? (
          <p className="text-xs text-faint">
            Select a day to see what you watched. Arrow keys move between days.
          </p>
        ) : (
          <>
            <p className="text-xs text-muted">
              {readableDay(selected)} ·{" "}
              <span className="tabular-nums">{selectedCount}</span> logged
            </p>
            {day && day.titles.length > 0 ? (
              <ul className="mt-1 flex flex-col">
                {day.titles.map((t) => (
                  <li key={t.id}>
                    <Link
                      href={`/title/${t.id}`}
                      className="focus-ring flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm hover:bg-surface-2/50 sm:min-h-0 sm:py-1"
                    >
                      <span className="min-w-0 flex-1 truncate">{t.name}</span>
                      {t.count > 1 && (
                        <span className="shrink-0 text-xs tabular-nums text-faint">
                          {t.count} entries
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
                {day.more > 0 && (
                  <li className="px-2 pt-1 text-xs text-faint">
                    and <span className="tabular-nums">{day.more}</span> more
                  </li>
                )}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-faint">Nothing logged on this day.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
