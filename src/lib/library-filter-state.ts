// The library's filters as one value: the reducer <Library> keeps them in, and
// everything derived from them (the URL and cookie mirror, whether anything is
// filtering, the facet chips, the Export link, the results memo key). Pure and
// client-safe, so a new filter is added to LibraryFilters and here, not to six
// places in the component.

import { STATUS_META, languageName } from "@/lib/format";
import type { LibraryFilters } from "@/lib/library-filters";

/** The reducer's state. The URL leaves onlyOnServices optional; here it is always a boolean. */
export type LibraryFilterState = Required<LibraryFilters>;

export type LibraryFilterPatch = Partial<LibraryFilterState>;

/** A patch, or a function of the current state for updates that toggle. */
export type LibraryFilterUpdate =
  | LibraryFilterPatch
  | ((state: LibraryFilterState) => LibraryFilterPatch);

export type LibraryFilterAction =
  | { type: "set"; update: LibraryFilterUpdate }
  | { type: "adopt"; filters: LibraryFilters }
  | { type: "clear" };

/**
 * What "Clear all" resets, and so what counts as filtering: every field that
 * narrows the results. Sort and view only order and lay them out, so they stay.
 */
const CLEARED: Omit<LibraryFilterState, "sort" | "view"> = {
  query: "",
  type: "all",
  status: "all",
  language: "all",
  tag: "all",
  genre: "all",
  rating: "all",
  onlyUnmatched: false,
  onlyOnServices: false,
};

export function toLibraryFilterState(filters: LibraryFilters): LibraryFilterState {
  return { ...filters, onlyOnServices: filters.onlyOnServices ?? false };
}

/**
 * Applies `patch`, or returns `state` itself when no field changes. That is
 * what the separate setters did, so the mirror effect and the results memo
 * still skip a no-op, and adopting the URL this component mirrored changes
 * nothing.
 */
function merge(state: LibraryFilterState, patch: LibraryFilterPatch): LibraryFilterState {
  for (const key of Object.keys(patch) as (keyof LibraryFilterState)[]) {
    if (!Object.is(state[key], patch[key])) return { ...state, ...patch };
  }
  return state;
}

export function libraryFiltersReducer(
  state: LibraryFilterState,
  action: LibraryFilterAction,
): LibraryFilterState {
  switch (action.type) {
    case "set":
      return merge(
        state,
        typeof action.update === "function" ? action.update(state) : action.update,
      );
    case "adopt":
      return merge(state, toLibraryFilterState(action.filters));
    case "clear":
      return merge(state, CLEARED);
  }
}

/** Anything narrowing the results besides the search text. */
export function hasFiltersBesidesSearch(filters: LibraryFilters): boolean {
  return (Object.keys(CLEARED) as (keyof typeof CLEARED)[]).some(
    (key) => key !== "query" && (filters[key] ?? CLEARED[key]) !== CLEARED[key],
  );
}

export function hasLibraryFilters(filters: LibraryFilters): boolean {
  return filters.query !== "" || hasFiltersBesidesSearch(filters);
}

export interface LibraryFilterChip {
  key: string;
  label: string;
  /** The patch that removes this chip's filter. */
  clear: LibraryFilterPatch;
}

// Active advanced facets, one removable chip each. Excludes type (its own
// quick-filter) and sort (ordering, not a filter), so the chip set and the
// disclosure badge count stay in step with what actually narrows the results.
export function libraryFilterChips(filters: LibraryFilters): LibraryFilterChip[] {
  const { status, language, genre, rating, tag, onlyUnmatched } = filters;
  const chips: LibraryFilterChip[] = [];
  if (status !== "all")
    chips.push({
      key: "status",
      label: `Status: ${STATUS_META[status].label}`,
      clear: { status: "all" },
    });
  if (language !== "all")
    chips.push({
      key: "language",
      label: `Language: ${languageName(language)}`,
      clear: { language: "all" },
    });
  if (genre !== "all")
    chips.push({ key: "genre", label: `Genre: ${genre}`, clear: { genre: "all" } });
  if (rating !== "all")
    chips.push({
      key: "rating",
      label: rating === "unrated" ? "Rating: Unrated" : `Rating: ${rating}+`,
      clear: { rating: "all" },
    });
  if (tag !== "all")
    chips.push({ key: "tag", label: `Tag: ${tag}`, clear: { tag: "all" } });
  if (onlyUnmatched)
    chips.push({
      key: "unmatched",
      label: "Needs match",
      clear: { onlyUnmatched: false },
    });
  return chips;
}

// Deep link to /export with the current filters pre-applied (query and the
// needs-match toggle have no export equivalent; sort doesn't affect content).
export function libraryExportHref(filters: LibraryFilters): string {
  const { type, status, tag, genre, language, rating } = filters;
  const p = new URLSearchParams();
  if (type !== "all") p.set("type", type === "MOVIE" ? "movie" : "tv");
  if (status !== "all") p.set("status", status);
  if (tag !== "all") p.set("tag", tag);
  if (genre !== "all") p.set("genre", genre);
  if (language !== "all") p.set("lang", language);
  if (rating !== "all" && rating !== "unrated") p.set("min", rating);
  const qs = p.toString();
  return qs ? `/export?${qs}` : "/export";
}

/** What the URL and the remembered-filters cookie mirror: the filters, search trimmed. */
export function libraryMirrorFilters(filters: LibraryFilters): LibraryFilters {
  return { ...filters, query: filters.query.trim() };
}

/** Every field that narrows or orders the results, less the search text and the view. */
export type LibraryResultCriteria = Omit<LibraryFilterState, "query" | "view">;

/**
 * JSON of the state's LibraryResultCriteria. The results memo is keyed on it
 * rather than on the whole state: the search text reaches that memo deferred,
 * and the view only lays the results out, so neither a keystroke nor a view
 * switch redoes the filter pass, and a new filter field joins the key by
 * itself.
 */
export function libraryResultsKey(filters: LibraryFilterState): string {
  return JSON.stringify(filters, (key, value) =>
    key === "query" || key === "view" ? undefined : value,
  );
}
