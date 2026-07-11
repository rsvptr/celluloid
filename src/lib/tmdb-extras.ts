// Pure, client-safe helpers for the title-page extras (watch providers,
// trailer, streaming region). No fetching here — testable logic only.

import type { TmdbProvider, TmdbRegionProviders, TmdbVideo } from "@/lib/tmdb";

/** Regions offered in the streaming-region picker (ISO 3166-1 alpha-2). */
export const WATCH_REGIONS = [
  "US",
  "GB",
  "IN",
  "CA",
  "AU",
  "DE",
  "FR",
  "ES",
  "IT",
  "NL",
  "SE",
  "JP",
  "KR",
  "BR",
  "MX",
  "AE",
] as const;

export type WatchRegion = (typeof WATCH_REGIONS)[number];

export const DEFAULT_WATCH_REGION: WatchRegion = "US";

export function isWatchRegion(v: string | null | undefined): v is WatchRegion {
  return !!v && (WATCH_REGIONS as readonly string[]).includes(v);
}

const regionDisplay =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function regionName(code: string): string {
  try {
    return regionDisplay?.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface ProviderGroup {
  label: "Stream" | "Rent" | "Buy";
  providers: TmdbProvider[];
}

export interface RegionWatchInfo {
  /** JustWatch page for this title in this region (TMDB terms ask for attribution). */
  link: string | null;
  groups: ProviderGroup[];
}

const GROUP_CAP = 8;

function dedupe(lists: (TmdbProvider[] | undefined)[]): TmdbProvider[] {
  const seen = new Set<number>();
  const out: TmdbProvider[] = [];
  for (const list of lists) {
    for (const p of list ?? []) {
      if (seen.has(p.provider_id)) continue;
      seen.add(p.provider_id);
      out.push(p);
    }
  }
  return out
    .sort((a, b) => (a.display_priority ?? 999) - (b.display_priority ?? 999))
    .slice(0, GROUP_CAP);
}

/**
 * Collapse a region's raw provider lists into display groups. Subscription,
 * free and ad-supported all read as "Stream"; a provider appearing in several
 * source lists shows once per group.
 */
export function regionWatchInfo(
  results: Record<string, TmdbRegionProviders> | undefined,
  region: string,
): RegionWatchInfo {
  const r = results?.[region];
  if (!r) return { link: null, groups: [] };
  const groups: ProviderGroup[] = [];
  const stream = dedupe([r.flatrate, r.free, r.ads]);
  const rent = dedupe([r.rent]);
  const buy = dedupe([r.buy]);
  if (stream.length) groups.push({ label: "Stream", providers: stream });
  if (rent.length) groups.push({ label: "Rent", providers: rent });
  if (buy.length) groups.push({ label: "Buy", providers: buy });
  return { link: r.link ?? null, groups };
}

export interface TrailerPick {
  key: string;
  name: string;
  url: string;
}

/**
 * Choose the best YouTube video for a "Watch trailer" link: official trailers
 * first, then any trailer, then a teaser — newest first within each tier.
 */
export function pickTrailer(videos: TmdbVideo[]): TrailerPick | null {
  const yt = videos.filter((v) => v.site === "YouTube" && v.key);
  const byDate = (a: TmdbVideo, b: TmdbVideo) =>
    (b.published_at ?? "").localeCompare(a.published_at ?? "");
  const tiers = [
    yt.filter((v) => v.type === "Trailer" && v.official).sort(byDate),
    yt.filter((v) => v.type === "Trailer").sort(byDate),
    yt.filter((v) => v.type === "Teaser").sort(byDate),
  ];
  for (const tier of tiers) {
    if (tier.length) {
      const v = tier[0];
      return { key: v.key, name: v.name, url: `https://www.youtube.com/watch?v=${v.key}` };
    }
  }
  return null;
}
