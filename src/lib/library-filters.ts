// Pure, client-safe library filter state <-> URL search param mapping. The URL
// is the source of truth for the library view (shareable, bookmarkable, and
// back-navigation restores it), so both sides live in one tested module.

import type { WatchStatus } from "@/generated/prisma/client";

export type SortKey = "added" | "watched" | "name" | "release" | "myrating" | "tmdb";
export type TypeFilter = "all" | "MOVIE" | "TV";
export type RatingFilter = "all" | "unrated" | "9" | "8" | "7" | "6" | "5";

export interface LibraryFilters {
  query: string;
  type: TypeFilter;
  status: WatchStatus | "all";
  language: string; // "all" or an ISO code present in the library
  tag: string; // "all" or a tag name
  genre: string; // "all" or a genre present in the library
  rating: RatingFilter;
  sort: SortKey;
  view: "grid" | "list";
  onlyUnmatched: boolean;
}

export const DEFAULT_FILTERS: LibraryFilters = {
  query: "",
  type: "all",
  status: "all",
  language: "all",
  tag: "all",
  genre: "all",
  rating: "all",
  sort: "added",
  view: "grid",
  onlyUnmatched: false,
};

export const SORT_KEYS: readonly SortKey[] = [
  "added",
  "watched",
  "name",
  "release",
  "myrating",
  "tmdb",
];

const RATINGS: readonly RatingFilter[] = ["all", "unrated", "9", "8", "7", "6", "5"];

const STATUS_BY_PARAM: Record<string, WatchStatus> = {
  watchlist: "WATCHLIST",
  watching: "WATCHING",
  watched: "WATCHED",
  on_hold: "ON_HOLD",
  dropped: "DROPPED",
};

export interface FilterFacets {
  languages: string[];
  tags: string[];
  genres: string[];
}

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Build validated filters from untrusted URL params. Facet values (language,
 * tag, genre) are checked against what the library actually contains, so a
 * stale or junk param can't silently filter everything while its select still
 * shows the default option.
 */
export function parseLibraryFilters(
  raw: Record<string, string | string[] | undefined>,
  facets: FilterFacets,
): LibraryFilters {
  const f: LibraryFilters = { ...DEFAULT_FILTERS };
  const q = first(raw.q);
  if (typeof q === "string") f.query = q.slice(0, 200);

  const type = first(raw.type);
  if (type === "movie") f.type = "MOVIE";
  else if (type === "tv") f.type = "TV";

  const status = first(raw.status)?.toLowerCase();
  if (status && STATUS_BY_PARAM[status]) f.status = STATUS_BY_PARAM[status];

  const lang = first(raw.lang);
  if (lang && facets.languages.includes(lang)) f.language = lang;

  const tag = first(raw.tag);
  if (tag && facets.tags.includes(tag)) f.tag = tag;

  const genre = first(raw.genre);
  if (genre && facets.genres.includes(genre)) f.genre = genre;

  const rating = first(raw.rating);
  if (rating && RATINGS.includes(rating as RatingFilter))
    f.rating = rating as RatingFilter;

  const sort = first(raw.sort);
  if (sort && SORT_KEYS.includes(sort as SortKey)) f.sort = sort as SortKey;

  if (first(raw.view) === "list") f.view = "list";
  if (first(raw.unmatched) === "1") f.onlyUnmatched = true;

  return f;
}

/** Serialize filters to URL params, omitting defaults so plain views stay `/`. */
export function filtersToParams(f: LibraryFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.query) p.set("q", f.query);
  if (f.type !== "all") p.set("type", f.type === "MOVIE" ? "movie" : "tv");
  if (f.status !== "all") p.set("status", f.status.toLowerCase());
  if (f.language !== "all") p.set("lang", f.language);
  if (f.tag !== "all") p.set("tag", f.tag);
  if (f.genre !== "all") p.set("genre", f.genre);
  if (f.rating !== "all") p.set("rating", f.rating);
  if (f.sort !== "added") p.set("sort", f.sort);
  if (f.view !== "grid") p.set("view", f.view);
  if (f.onlyUnmatched) p.set("unmatched", "1");
  return p;
}
