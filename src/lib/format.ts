import type { MediaType, WatchStatus } from "@/generated/prisma/client";
import { LANGUAGE_NAMES } from "@/lib/language-names";

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

const countFormat = new Intl.NumberFormat("en-US");

/** A count with digit grouping: 12345 → "12,345" (JK-28). */
export function formatCount(n: number): string {
  return countFormat.format(n);
}

export function mediaTypeLabel(t: MediaType): string {
  return t === "TV" ? "TV" : "Movie";
}

/**
 * "The Long, Hot Summer (TV, 1965)": a TMDB result's name with its type and
 * year, for accessible names that must tell a show from a same-named movie
 * (JK-21).
 */
export function nameWithTypeAndYear(
  name: string,
  mediaType: "movie" | "tv",
  year?: string | number | null,
): string {
  const type = mediaType === "tv" ? "TV" : "Movie";
  return `${name} (${year ? `${type}, ${year}` : type})`;
}

/**
 * TMDB's TV lifecycle string, softened for display. "Ended" (concluded its
 * run) and "Canceled" (axed) are deliberately kept distinct — whether a show
 * got a real ending is exactly what a viewer deciding to start it wants to
 * know; only the spelling of "Canceled" is normalized. Anything else (e.g.
 * "Planned", "In Production") keeps TMDB's words in sentence case.
 */
export function tvStatusLabel(status: string): string {
  if (status === "Returning Series") return "Returning";
  if (status === "Canceled") return "Cancelled";
  return status.charAt(0) + status.slice(1).toLowerCase();
}

/**
 * When a show's latest episode aired, for a meta line: "aired today", "aired
 * 12 days ago", "aired 3 weeks ago", then the date itself once it is 8 weeks
 * or more back ("aired Apr 7, 2022"), where a day count stops meaning much.
 * Both arguments are UTC calendar-date keys (YYYY-MM-DD).
 */
export function airedAgoText(dateKey: string, todayKey: string): string {
  const days = Math.round(
    (Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dateKey}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return "aired today";
  if (days === 1) return "aired yesterday";
  if (days < 14) return `aired ${days} days ago`;
  if (days < 56) return `aired ${Math.floor(days / 7)} weeks ago`;
  const date = new Date(`${dateKey}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return `aired ${date}`;
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

export function languageName(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return LANGUAGE_NAMES[code] ?? code;
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
