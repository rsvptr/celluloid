import type { MediaType, WatchStatus } from "@/generated/prisma/client";

export const STATUS_META: Record<
  WatchStatus,
  { label: string; dot: string; badge: string }
> = {
  WATCHLIST: {
    label: "Watchlist",
    dot: "bg-sky-400",
    badge: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
  },
  WATCHING: {
    label: "Watching",
    dot: "bg-amber-400",
    badge: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  },
  WATCHED: {
    label: "Watched",
    dot: "bg-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  },
  ON_HOLD: {
    label: "On hold",
    dot: "bg-slate-400",
    badge: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
  },
  DROPPED: {
    label: "Dropped",
    dot: "bg-rose-400",
    badge: "bg-rose-500/15 text-rose-300 ring-rose-500/30",
  },
};

export const STATUS_ORDER: WatchStatus[] = [
  "WATCHING",
  "WATCHLIST",
  "WATCHED",
  "ON_HOLD",
  "DROPPED",
];

export function mediaTypeLabel(t: MediaType): string {
  return t === "TV" ? "TV" : "Movie";
}

export function year(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "";
  return String(d.getUTCFullYear());
}

export function fullDate(date: Date | string | null | undefined): string {
  if (!date) return "Unknown";
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return "Unknown";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

const langDisplay =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "language" })
    : null;

export function languageName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  try {
    return langDisplay?.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function runtimeText(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function ratingText(rating: number | null | undefined): string {
  if (rating == null) return "";
  return rating.toFixed(1);
}

/** Episode progress as a 0–100 percentage. */
export function progressPct(watched: number, total: number | null | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((watched / total) * 100));
}
