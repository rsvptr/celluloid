import type { MediaType, WatchStatus } from "@/generated/prisma/client";

export const STATUS_META: Record<
  WatchStatus,
  { label: string; dot: string; badge: string }
> = {
  WATCHLIST: {
    label: "Watchlist",
    dot: "bg-status-watchlist-solid",
    badge: "bg-status-watchlist-subtle text-status-watchlist-text ring-status-watchlist-border",
  },
  WATCHING: {
    label: "Watching",
    dot: "bg-status-watching-solid",
    badge: "bg-status-watching-subtle text-status-watching-text ring-status-watching-border",
  },
  WATCHED: {
    label: "Watched",
    dot: "bg-status-watched-solid",
    badge: "bg-status-watched-subtle text-status-watched-text ring-status-watched-border",
  },
  ON_HOLD: {
    label: "On hold",
    dot: "bg-status-on-hold-solid",
    badge: "bg-status-on-hold-subtle text-status-on-hold-text ring-status-on-hold-border",
  },
  DROPPED: {
    label: "Dropped",
    dot: "bg-status-dropped-solid",
    badge: "bg-status-dropped-subtle text-status-dropped-text ring-status-dropped-border",
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
