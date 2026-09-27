import { z } from "zod";
import {
  MAX_COOKIE_BYTES,
  STATE_VERSION,
  type ExportRememberedScope,
  type ExportRememberedState,
  type LibraryRememberedState,
  type RecommendRememberedState,
} from "@/lib/remembered-state-client";

// Server half of the remembered-filters feature (D-006): the strict Zod
// parsers the RSC pages restore first paint from. The client half
// (remembered-state-client.ts) holds the cookie names, writers and encoders,
// and is deliberately Zod-free — see AUD-NEXT-01. The schemas below are
// annotated with the client module's interfaces, so if either half changes
// shape without the other, tsc fails instead of the cookie silently rotting.
// This module is the trust boundary: every cookie is parsed strictly here on
// read, and anything malformed degrades to defaults per surface.

export {
  isRememberFiltersEnabled,
  REMEMBER_FILTERS_TOGGLE_COOKIE,
  REMEMBERED_COOKIE_NAMES,
  REMEMBERED_COOKIE_PREFIX,
  type ExportRememberedScope,
  type ExportRememberedState,
  type LibraryRememberedState,
  type RecommendRememberedState,
} from "@/lib/remembered-state-client";

const libraryStateSchema: z.ZodType<LibraryRememberedState> = z
  .object({
    v: z.literal(STATE_VERSION),
    type: z.enum(["all", "MOVIE", "TV"]),
    status: z.enum(["all", "WATCHLIST", "WATCHING", "WATCHED", "ON_HOLD", "DROPPED"]),
    language: z.string().max(32),
    tag: z.string().max(100),
    genre: z.string().max(100),
    rating: z.enum(["all", "unrated", "9", "8", "7", "6", "5"]),
    sort: z.enum(["added", "watched", "name", "release", "myrating", "tmdb"]),
    view: z.enum(["grid", "list"]),
    onlyUnmatched: z.boolean(),
    onlyOnServices: z.boolean(),
  })
  .strict();

const recommendStateSchema: z.ZodType<RecommendRememberedState> = z
  .object({
    v: z.literal(STATE_VERSION),
    count: z.number().int().min(1).max(30),
    type: z.enum(["all", "movie", "tv"]),
    preset: z.string().max(100).nullable(),
    language: z.string().max(32),
    genre: z.string().max(100),
    era: z.string().max(32),
    basisMode: z.enum(["all", "recent"]),
    recentCount: z.union([z.literal(10), z.literal(20), z.literal(50)]),
  })
  .strict();

const exportScopeSchema: z.ZodType<ExportRememberedScope> = z
  .object({
    type: z.enum(["all", "movie", "tv"]),
    status: z.enum(["all", "WATCHLIST", "WATCHING", "WATCHED", "ON_HOLD", "DROPPED"]),
    favoritesOnly: z.boolean(),
    tag: z.string().max(100).nullable(),
    language: z.string().max(32).nullable(),
    genre: z.string().max(100).nullable(),
    minRating: z.number().min(1).max(10).nullable(),
    yearFrom: z.number().int().min(1870).max(2100).nullable(),
    yearTo: z.number().int().min(1870).max(2100).nullable(),
  })
  .strict();

const exportStateSchema: z.ZodType<ExportRememberedState> = z
  .object({
    v: z.literal(STATE_VERSION),
    format: z.enum(["ai", "text", "markdown", "json", "xlsx"]),
    scope: exportScopeSchema,
  })
  .strict();

function parseState<T>(raw: string | null | undefined, schema: z.ZodType<T>): T | null {
  if (!raw || new TextEncoder().encode(raw).byteLength > MAX_COOKIE_BYTES) return null;
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = schema.safeParse(JSON.parse(decoded));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseLibraryRememberedState(
  raw: string | null | undefined,
): LibraryRememberedState | null {
  return parseState(raw, libraryStateSchema);
}

/** Convert saved values back through the library's existing facet validator. */
export function libraryRememberedStateToParams(
  state: LibraryRememberedState | null,
): Record<string, string> {
  if (!state) return {};
  return {
    type: state.type === "MOVIE" ? "movie" : state.type === "TV" ? "tv" : "all",
    status: state.status.toLowerCase(),
    lang: state.language,
    tag: state.tag,
    genre: state.genre,
    rating: state.rating,
    sort: state.sort,
    view: state.view,
    unmatched: state.onlyUnmatched ? "1" : "0",
    services: state.onlyOnServices ? "1" : "0",
  };
}

// Lives with the URL mapping so the library can apply the same rule in the
// browser without importing this module's Zod schemas (AUD-NEXT-01).
export { hasExplicitLibraryFilterParams } from "@/lib/library-filters";

export function parseRecommendRememberedState(
  raw: string | null | undefined,
): RecommendRememberedState | null {
  return parseState(raw, recommendStateSchema);
}

export function parseExportRememberedState(
  raw: string | null | undefined,
): ExportRememberedState | null {
  return parseState(raw, exportStateSchema);
}

const EXPORT_SCOPE_PARAM_KEYS = new Set([
  "type",
  "status",
  "tag",
  "genre",
  "lang",
  "min",
  "from",
  "to",
  "fav",
]);

export function hasExplicitExportScopeParams(
  raw: Record<string, string | string[] | undefined>,
): boolean {
  return Object.keys(raw).some((key) => EXPORT_SCOPE_PARAM_KEYS.has(key));
}
