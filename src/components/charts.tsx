"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

// --- Horizontal bar rows ---------------------------------------------------

export function BarRow({
  label,
  value,
  max,
  colorClass,
}: {
  label: string;
  value: number;
  max: number;
  colorClass?: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 truncate text-xs text-muted" title={label}>
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div
          className={cn(
            "h-full origin-left rounded-full motion-safe:animate-[grow-x_300ms_cubic-bezier(0.23,1,0.32,1)]",
            colorClass ?? "brand-gradient",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-8 shrink-0 text-right text-xs tabular-nums text-muted">
        {value}
      </span>
    </div>
  );
}

// --- Vertical column chart (rating histogram, decades) ---------------------

export function ColumnChart({
  data,
  height = 140,
}: {
  data: { label: string; value: number }[];
  height?: number;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  // Bars are sized in PIXELS, not percentages: the column wrappers get their
  // height from content (the row only bottom-aligns them), so a % height has
  // no definite parent to resolve against and silently computes to 0.
  // Minus the value and axis labels (two 16px text-xs lines) and two 4px gaps.
  const barArea = height - 40;
  return (
    <div
      role="img"
      aria-label={data.map((d) => `${d.label}: ${d.value}`).join(", ")}
      className="flex items-end gap-1.5"
      style={{ height }}
    >
      {data.map((d, i) => {
        const px = d.value > 0 ? Math.max((d.value / max) * barArea, 4) : 0;
        return (
          <div
            key={d.label}
            className="flex flex-1 flex-col items-center justify-end gap-1"
          >
            {d.value > 0 && (
              <span className="text-xs tabular-nums text-faint">{d.value}</span>
            )}
            <div
              title={`${d.label}: ${d.value}`}
              className="w-full rounded-t-md brand-gradient motion-safe:animate-[grow-y_300ms_cubic-bezier(0.23,1,0.32,1)]"
              style={{ height: px, transformOrigin: "bottom" }}
            />
            {/* Past 8 buckets, labels collide at narrow widths; drop every
                other one but keep its slot (invisible, not unmounted) so bars
                stay on a common baseline. */}
            <span
              className={cn(
                "text-xs text-faint",
                data.length > 8 && i % 2 !== 0 && "invisible",
              )}
            >
              {d.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// --- Sparkline / area (titles by year) -------------------------------------

export function Sparkline({
  points,
  labels,
  height = 120,
}: {
  points: number[];
  labels?: [string, string]; // [first, last]
  height?: number;
}) {
  const W = 600;
  const H = height;
  const pad = 6;
  const { line, area } = useMemo(() => {
    if (points.length === 0) return { line: "", area: "" };
    const max = Math.max(...points, 1);
    const n = points.length;
    const x = (i: number) =>
      n === 1 ? W / 2 : pad + (i / (n - 1)) * (W - pad * 2);
    const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
    const line = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `${line} L${x(n - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
    return { line, area };
  }, [points, H]);

  if (points.length === 0) {
    return <p className="text-sm text-muted">Not enough data.</p>;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const sparkLabel =
    `Trend across ${points.length} points, ranging from ${min} to ${max}` +
    (labels ? `, from ${labels[0]} to ${labels[1]}` : "");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height }}
        role="img"
        aria-label={sparkLabel}
      >
        <defs>
          <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2dd4ee" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#2dd4ee" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path
          d={area}
          fill="url(#spark-fill)"
          className="motion-safe:animate-[fade-in_300ms_cubic-bezier(0.23,1,0.32,1)]"
        />
        <path
          d={line}
          fill="none"
          stroke="#2dd4ee"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          className="motion-safe:animate-[draw-line_400ms_cubic-bezier(0.23,1,0.32,1)]"
        />
      </svg>
      {labels && (
        <div className="mt-1 flex justify-between text-xs tabular-nums text-faint">
          <span>{labels[0]}</span>
          <span>{labels[1]}</span>
        </div>
      )}
    </div>
  );
}

// --- Activity heatmap grid maths (consumed by the interactive calendar) ----

/**
 * Lays out the visible weeks x 7 day grid and aggregates total/max from ONLY
 * the days inside that window. `activity` can span a user's entire watch
 * history, so totalling or scaling colors over the raw array would let
 * history outside the visible weeks inflate the "last year" total and flatten
 * the color scale. `todayKey` is the owner's local "today" as a "YYYY-MM-DD"
 * key (see dayKeyInZone in lib/data) — `activity`'s own keys are bucketed the
 * same way, so anchoring the grid to a client clock's `new Date()` instead
 * would land a cell a day off the owner's real calendar whenever the server
 * and the owner sit in different UTC offsets.
 */
export function windowActivity(
  activity: { date: string; count: number }[],
  weeks: number,
  todayKey: string,
): {
  cols: { date: string; count: number; future: boolean }[][];
  total: number;
  max: number;
} {
  // Parse the owner-zone key as UTC midnight, same as computeStreaks, so the
  // grid's day-stepping arithmetic below stays plain Gregorian date math.
  const [year, month, day] = todayKey.split("-").map(Number);
  const todayUtc = new Date(Date.UTC(year, month - 1, day));
  // End at the upcoming Saturday so the last column is full.
  const end = new Date(todayUtc);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (weeks * 7 - 1));

  // Restrict to the visible window before aggregating, so a day outside the
  // grid (e.g. an old import) cannot skew the total or the color scale.
  const startKey = start.toISOString().slice(0, 10);
  const endKey = end.toISOString().slice(0, 10);
  const visible = activity.filter((a) => a.date >= startKey && a.date <= endKey);

  const map = new Map(visible.map((a) => [a.date, a.count]));
  const total = visible.reduce((s, a) => s + a.count, 0);
  const max = Math.max(...visible.map((a) => a.count), 1);

  const cols: { date: string; count: number; future: boolean }[][] = [];
  const cursor = new Date(start);
  for (let w = 0; w < weeks; w++) {
    const col: { date: string; count: number; future: boolean }[] = [];
    for (let d = 0; d < 7; d++) {
      const key = cursor.toISOString().slice(0, 10);
      col.push({ date: key, count: map.get(key) ?? 0, future: cursor > todayUtc });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    cols.push(col);
  }
  return { cols, total, max };
}
