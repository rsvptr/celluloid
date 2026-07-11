/**
 * Server-side TMDB v3 client. Authenticates with the v4 Read Access Token
 * (Bearer). Never import this into client components — it reads a secret.
 */

const BASE = "https://api.themoviedb.org/3";
export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/";

function getToken(): string {
  const t = process.env.TMDB_ACCESS_TOKEN;
  if (!t) {
    throw new Error(
      "TMDB_ACCESS_TOKEN is not set. Add your TMDB v4 Read Access Token to .env.",
    );
  }
  return t;
}

type FetchInit = RequestInit & { next?: { revalidate?: number } };

interface TmdbOptions {
  /** Next.js cache revalidation seconds (ignored outside Next). */
  revalidate?: number;
  retries?: number;
}

async function tmdb<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  opts: TmdbOptions = {},
): Promise<T> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const init: FetchInit = {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        accept: "application/json",
      },
    };
    if (opts.revalidate !== undefined) init.next = { revalidate: opts.revalidate };

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (attempt < retries) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      throw err;
    }

    if (res.ok) return (await res.json()) as T;

    // Back off on rate limits / transient server errors. Cap the honored
    // Retry-After so a pathological header can't stall a serverless function
    // for its whole timeout budget.
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, 5000);
      await sleep(wait);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Response types --------------------------------------------------------

export interface TmdbSearchItem {
  id: number;
  media_type: "movie" | "tv" | "person";
  title?: string; // movie
  name?: string; // tv / person
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string; // movie
  first_air_date?: string; // tv
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  original_language?: string;
  genre_ids?: number[];
}

interface TmdbPage<T> {
  page: number;
  results: T[];
  total_pages: number;
  total_results: number;
}

export interface TmdbGenre {
  id: number;
  name: string;
}

export interface TmdbMovieDetails {
  id: number;
  title: string;
  original_title: string;
  overview: string;
  release_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  original_language: string;
  runtime: number | null;
  genres: TmdbGenre[];
}

export interface TmdbSeasonSummary {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  poster_path: string | null;
  episode_count: number;
}

export interface TmdbTvDetails {
  id: number;
  name: string;
  original_name: string;
  overview: string;
  first_air_date: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  original_language: string;
  episode_run_time: number[];
  number_of_seasons: number;
  number_of_episodes: number;
  genres: TmdbGenre[];
  seasons: TmdbSeasonSummary[];
}

export interface TmdbEpisode {
  id: number;
  episode_number: number;
  season_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  runtime: number | null;
  still_path: string | null;
  vote_average: number;
}

export interface TmdbSeasonDetails {
  id: number;
  season_number: number;
  name: string;
  overview: string;
  air_date: string | null;
  poster_path: string | null;
  episodes: TmdbEpisode[];
}

// --- Endpoints -------------------------------------------------------------

export async function searchMulti(
  query: string,
  page = 1,
): Promise<(TmdbSearchItem & { media_type: "movie" | "tv" })[]> {
  if (!query.trim()) return [];
  const data = await tmdb<TmdbPage<TmdbSearchItem>>(
    "/search/multi",
    { query, page, include_adult: false, language: "en-US" },
    { revalidate: 60 * 60 },
  );
  return data.results.filter(
    (r): r is TmdbSearchItem & { media_type: "movie" | "tv" } =>
      r.media_type === "movie" || r.media_type === "tv",
  );
}

export async function searchByType(
  kind: "movie" | "tv",
  query: string,
  page = 1,
): Promise<TmdbSearchItem[]> {
  if (!query.trim()) return [];
  const data = await tmdb<TmdbPage<TmdbSearchItem>>(
    `/search/${kind}`,
    { query, page, include_adult: false, language: "en-US" },
    { revalidate: 60 * 60 },
  );
  return data.results.map((r) => ({ ...r, media_type: kind }));
}

export function getMovie(id: number): Promise<TmdbMovieDetails> {
  return tmdb<TmdbMovieDetails>(`/movie/${id}`, { language: "en-US" }, { revalidate: 60 * 60 * 24 });
}

export function getTv(id: number): Promise<TmdbTvDetails> {
  return tmdb<TmdbTvDetails>(`/tv/${id}`, { language: "en-US" }, { revalidate: 60 * 60 * 24 });
}

export function getSeason(tvId: number, seasonNumber: number): Promise<TmdbSeasonDetails> {
  return tmdb<TmdbSeasonDetails>(
    `/tv/${tvId}/season/${seasonNumber}`,
    { language: "en-US" },
    { revalidate: 60 * 60 * 24 },
  );
}

// --- Title extras: watch providers, related titles, videos ------------------

export interface TmdbProvider {
  provider_id: number;
  provider_name: string;
  logo_path: string | null;
  display_priority?: number;
}

export interface TmdbRegionProviders {
  link?: string;
  flatrate?: TmdbProvider[];
  free?: TmdbProvider[];
  ads?: TmdbProvider[];
  rent?: TmdbProvider[];
  buy?: TmdbProvider[];
}

export interface TmdbWatchProviders {
  id: number;
  results: Record<string, TmdbRegionProviders>;
}

export function getWatchProviders(
  kind: "movie" | "tv",
  id: number,
): Promise<TmdbWatchProviders> {
  return tmdb<TmdbWatchProviders>(
    `/${kind}/${id}/watch/providers`,
    {},
    { revalidate: 60 * 60 * 24 },
  );
}

export interface TmdbVideo {
  site: string;
  type: string;
  official?: boolean;
  key: string;
  name: string;
  published_at?: string;
}

export async function getVideos(kind: "movie" | "tv", id: number): Promise<TmdbVideo[]> {
  const data = await tmdb<{ id: number; results: TmdbVideo[] }>(
    `/${kind}/${id}/videos`,
    { language: "en-US" },
    { revalidate: 60 * 60 * 24 },
  );
  return data.results ?? [];
}

/**
 * Titles related to this one, for the "More like this" row. TMDB's
 * /recommendations (behavioral) beats /similar (metadata-only), but it's often
 * empty for regional titles — fall back to /similar so those aren't blank.
 */
export async function getRelatedTitles(
  kind: "movie" | "tv",
  id: number,
): Promise<TmdbSearchItem[]> {
  const rec = await tmdb<TmdbPage<TmdbSearchItem>>(
    `/${kind}/${id}/recommendations`,
    { language: "en-US" },
    { revalidate: 60 * 60 * 24 },
  );
  let results = rec.results ?? [];
  if (results.length === 0) {
    const sim = await tmdb<TmdbPage<TmdbSearchItem>>(
      `/${kind}/${id}/similar`,
      { language: "en-US" },
      { revalidate: 60 * 60 * 24 },
    );
    results = sim.results ?? [];
  }
  return results.map((r) => ({ ...r, media_type: kind }));
}
