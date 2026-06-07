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

export type BackdropSize = "w300" | "w780" | "w1280" | "original";

export function backdropUrl(
  path: string | null | undefined,
  size: BackdropSize = "w1280",
): string | null {
  return path ? `${TMDB_IMAGE_BASE}${size}${path}` : null;
}
