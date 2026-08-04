// Client half of the remembered-filters feature (D-006): cookie names, the
// browser cookie writers, and the encoders. Deliberately Zod-free — importing
// the server module's schemas shipped a ~64 KB (gzip) Zod chunk to five routes
// (AUD-NEXT-01) to validate values the client itself just produced from typed
// state. The trust boundary is the SERVER parse in remembered-state.ts: every
// cookie is re-validated strictly there on read, so a malformed write degrades
// to defaults exactly as a corrupt cookie always did. The types below are the
// contract; the server's schemas are annotated with them so the two halves
// cannot drift without a type error.

export const STATE_VERSION = 1;
export const MAX_COOKIE_BYTES = 1024;
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

export const REMEMBER_FILTERS_TOGGLE_COOKIE = "celluloid-remember-filters";
export const REMEMBERED_COOKIE_PREFIX = "celluloid-filters.";
export const REMEMBERED_COOKIE_NAMES = {
  library: `${REMEMBERED_COOKIE_PREFIX}library`,
  recommend: `${REMEMBERED_COOKIE_PREFIX}recommend`,
  export: `${REMEMBERED_COOKIE_PREFIX}export`,
} as const;

export type RememberedCookieName =
  (typeof REMEMBERED_COOKIE_NAMES)[keyof typeof REMEMBERED_COOKIE_NAMES];

export type LibraryRememberedState = {
  v: typeof STATE_VERSION;
  type: "all" | "MOVIE" | "TV";
  status: "all" | "WATCHLIST" | "WATCHING" | "WATCHED" | "ON_HOLD" | "DROPPED";
  language: string;
  tag: string;
  genre: string;
  rating: "all" | "unrated" | "9" | "8" | "7" | "6" | "5";
  sort: "added" | "watched" | "name" | "release" | "myrating" | "tmdb";
  view: "grid" | "list";
  onlyUnmatched: boolean;
  onlyOnServices: boolean;
};

export type RecommendRememberedState = {
  v: typeof STATE_VERSION;
  count: number;
  type: "all" | "movie" | "tv";
  preset: string | null;
  language: string;
  genre: string;
  era: string;
  basisMode: "all" | "recent";
  recentCount: 10 | 20 | 50;
};

export type ExportRememberedScope = {
  type: "all" | "movie" | "tv";
  status: "all" | "WATCHLIST" | "WATCHING" | "WATCHED" | "ON_HOLD" | "DROPPED";
  favoritesOnly: boolean;
  tag: string | null;
  language: string | null;
  genre: string | null;
  minRating: number | null;
  yearFrom: number | null;
  yearTo: number | null;
};

export type ExportRememberedState = {
  v: typeof STATE_VERSION;
  format: "ai" | "text" | "markdown" | "json" | "xlsx";
  scope: ExportRememberedScope;
};

/** Missing is ON; only the exact persisted opt-out disables remembering. */
export function isRememberFiltersEnabled(raw: string | null | undefined): boolean {
  return raw !== "0";
}

/** URI-encoded JSON, or null when it can't fit the cookie byte cap. */
function encodeState(value: unknown): string | null {
  const encoded = encodeURIComponent(JSON.stringify(value));
  return new TextEncoder().encode(encoded).byteLength <= MAX_COOKIE_BYTES
    ? encoded
    : null;
}

export function encodeLibraryRememberedState(filters: {
  /** Accepted so LibraryFilters passes whole; deliberately NEVER persisted. */
  query?: string;
  type: LibraryRememberedState["type"];
  status: LibraryRememberedState["status"];
  language: string;
  tag: string;
  genre: string;
  rating: LibraryRememberedState["rating"];
  sort: LibraryRememberedState["sort"];
  view: LibraryRememberedState["view"];
  onlyUnmatched: boolean;
  onlyOnServices?: boolean;
}): string | null {
  const state: LibraryRememberedState = {
    v: STATE_VERSION,
    type: filters.type,
    status: filters.status,
    language: filters.language,
    tag: filters.tag,
    genre: filters.genre,
    rating: filters.rating,
    sort: filters.sort,
    view: filters.view,
    onlyUnmatched: filters.onlyUnmatched,
    onlyOnServices: Boolean(filters.onlyOnServices),
  };
  return encodeState(state);
}

export function encodeRecommendRememberedState(
  value: Omit<RecommendRememberedState, "v">,
): string | null {
  const state: RecommendRememberedState = { v: STATE_VERSION, ...value };
  return encodeState(state);
}

export function encodeExportRememberedState(
  format: ExportRememberedState["format"],
  scope: ExportRememberedScope,
): string | null {
  const state: ExportRememberedState = { v: STATE_VERSION, format, scope };
  return encodeState(state);
}

function browserCookieSuffix(): string {
  return typeof window !== "undefined" && window.location.protocol === "https:"
    ? "; Secure"
    : "";
}

function browserRememberFiltersEnabled(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const toggle = document.cookie
      .split(";")
      .map((pair) => pair.trim())
      .find((pair) => pair.startsWith(`${REMEMBER_FILTERS_TOGGLE_COOKIE}=`));
    return isRememberFiltersEnabled(toggle?.slice(toggle.indexOf("=") + 1));
  } catch {
    return false;
  }
}

export function writeRememberedCookie(
  name: RememberedCookieName,
  encoded: string | null,
): void {
  if (typeof document === "undefined" || !browserRememberFiltersEnabled()) return;
  try {
    document.cookie = encoded
      ? `${name}=${encoded}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${browserCookieSuffix()}`
      : `${name}=; Path=/; Max-Age=0; SameSite=Lax${browserCookieSuffix()}`;
  } catch {
    // Cookie persistence is best-effort (blocked storage/private browsing).
  }
}

export function setRememberFiltersEnabled(enabled: boolean): void {
  if (typeof document === "undefined") return;
  try {
    document.cookie = `${REMEMBER_FILTERS_TOGGLE_COOKIE}=${enabled ? "1" : "0"}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${browserCookieSuffix()}`;
  } catch {
    return;
  }
  if (!enabled) clearRememberedSurfaceCookies();
}

export function clearRememberedSurfaceCookies(): void {
  if (typeof document === "undefined") return;
  const names = new Set<string>(Object.values(REMEMBERED_COOKIE_NAMES));
  let visibleCookies = "";
  try {
    visibleCookies = document.cookie;
  } catch {
    // Still clear every known surface name below.
  }
  for (const pair of visibleCookies.split(";")) {
    const name = pair.split("=", 1)[0]?.trim();
    if (name?.startsWith(REMEMBERED_COOKIE_PREFIX)) names.add(name);
  }
  for (const name of names) {
    try {
      document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax${browserCookieSuffix()}`;
    } catch {
      // Keep clearing the remaining known surface cookies.
    }
  }
}
