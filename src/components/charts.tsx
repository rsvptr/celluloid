"use client";

import { useMemo } from "react";
import { motion } from "@/components/motion";
import { cn } from "@/lib/utils";

const EASE = [0.16, 1, 0.3, 1] as const;

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
      <span className="w-24 shrink-0 truncate text-xs text-muted">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
        <motion.div
          className={cn("h-full origin-left rounded-full", colorClass ?? "brand-gradient")}
          style={{ width: `${pct}%` }}
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: 0.6, ease: EASE }}
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
  const barArea = height - 38; // minus the value label, axis label, and gaps
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
              <span className="text-[10px] tabular-nums text-faint">{d.value}</span>
            )}
            <motion.div
              title={`${d.label}: ${d.value}`}
              className="w-full rounded-t-md brand-gradient"
              style={{ height: px, transformOrigin: "bottom" }}
              initial={{ scaleY: 0 }}
              animate={{ scaleY: 1 }}
              transition={{ duration: 0.5, ease: EASE, delay: i * 0.02 }}
            />
            <span className="text-[10px] text-faint">{d.label}</span>
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
        <motion.path
          d={area}
          fill="url(#spark-fill)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, ease: EASE }}
        />
        <motion.path
          d={line}
          fill="none"
          stroke="#2dd4ee"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1, ease: EASE }}
        />
      </svg>
      {labels && (
        <div className="mt-1 flex justify-between text-[10px] tabular-nums text-faint">
          <span>{labels[0]}</span>
          <span>{labels[1]}</span>
        </div>
      )}
    </div>
  );
}

// --- Activity heatmap (GitHub-style) ---------------------------------------

const LEVEL_CLASS = [
  "bg-surface-2",
  "bg-brand/25",
  "bg-brand/45",
  "bg-brand/70",
  "bg-brand",
];

/**
 * Lays out the visible weeks x 7 day grid and aggregates total/max from ONLY
 * the days inside that window. `activity` can span a user's entire watch
 * history, so totalling or scaling colors over the raw array would let
 * history outside the visible weeks inflate the "last year" total and flatten
 * the color scale. `today` is injectable for deterministic tests; it defaults
 * to the real current time for the live component.
 */
export function windowActivity(
  activity: { date: string; count: number }[],
  weeks: number,
  today: Date = new Date(),
): {
  cols: { date: string; count: number; future: boolean }[][];
  total: number;
  max: number;
} {
  // Use UTC throughout so the grid's own day keys are internally consistent.
  // `activity` entries come from getStats as "YYYY-MM-DD" strings bucketed in
  // the owner's time zone (not necessarily UTC); comparing those keys as plain
  // strings against this UTC-built grid is still correct since both sides use
  // the same Y-M-D format, but a day may land one cell off from the owner's
  // real local calendar near their midnight if the server and owner differ in
  // UTC offset from "now".
  const todayUtc = new Date(today);
  todayUtc.setUTCHours(0, 0, 0, 0);
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

export function ActivityHeatmap({
  activity,
  weeks = 53,
}: {
  activity: { date: string; count: number }[];
  weeks?: number;
}) {
  const { cols, total, max } = useMemo(
    () => windowActivity(activity, weeks),
    [activity, weeks],
  );

  const level = (c: number) => {
    if (c <= 0) return 0;
    const r = c / max;
    if (r > 0.66) return 4;
    if (r > 0.33) return 3;
    if (r > 0) return 2;
    return 1;
  };

  return (
    <div>
      <div
        className="overflow-x-auto pb-1"
        role="img"
        aria-label={`Watch activity heatmap: ${total} watched in the last year`}
      >
        <div className="flex gap-[3px]">
          {cols.map((col, ci) => (
            <div key={ci} className="flex flex-col gap-[3px]">
              {col.map((cell) => (
                <div
                  key={cell.date}
                  title={cell.future ? "" : `${cell.date}: ${cell.count} watched`}
                  className={cn(
                    "h-[11px] w-[11px] rounded-[2px]",
                    cell.future ? "bg-transparent" : LEVEL_CLASS[level(cell.count)],
                  )}
                />
              ))}
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
    </div>
  );
}
