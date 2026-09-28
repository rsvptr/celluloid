// Client-safe TMDB image URL helpers (no secrets, no server code).

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

export type PosterSize =
  | "w92"
  | "w154"
  | "w185"
  | "w342"
  | "w500"
  | "w780"
  | "original";

export type StillSize = "w92" | "w185" | "w300" | "original";

export function posterUrl(
  path: string | null | undefined,
  size: PosterSize = "w342",
): string | null {
  return path ? `${TMDB_IMAGE_BASE}${size}${path}` : null;
}

export function stillUrl(
  path: string | null | undefined,
  size: StillSize = "w300",
): string | null {
  return path ? `${TMDB_IMAGE_BASE}${size}${path}` : null;
}

/**
 * The widths TMDB renders each image type at, from GET /configuration
 * (tmdb-docs/reference/configuration-details.md); `original` sits above them.
 * Profiles also come as h632, a height, which no width maps onto.
 */
const TMDB_WIDTHS = {
  poster: [92, 154, 185, 342, 500, 780],
  backdrop: [300, 780, 1280],
  logo: [45, 92, 154, 185, 300, 500],
  profile: [45, 185],
} as const;

export type TmdbImageKind = keyof typeof TMDB_WIDTHS;
export type TmdbSize<K extends TmdbImageKind> = `w${(typeof TMDB_WIDTHS)[K][number]}` | "original";

/**
 * The smallest size of `kind` that TMDB serves at least `width` pixels wide,
 * or `original` past the largest, but no larger than `max`.
 */
export function tmdbSize<K extends TmdbImageKind>(
  kind: K,
  width: number,
  max: TmdbSize<K> = "original",
): TmdbSize<K> {
  const widths: readonly number[] = TMDB_WIDTHS[kind];
  const fit = widths.find((w) => w >= width) ?? Infinity;
  const cap = max === "original" ? Infinity : Number(max.slice(1));
  const size = Math.min(fit, cap);
  return size === Infinity ? "original" : (`w${size}` as TmdbSize<K>);
}
