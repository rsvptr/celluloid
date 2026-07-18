/**
 * Server-side TMDB v3 client. Authenticates with the v4 Read Access Token
 * (Bearer). Never import this into client components — it reads a secret.
 */

import {
  imdbUrl,
  pickCreators,
  pickDirector,
  pickMovieCertification,
  pickTopCast,
  pickTvCertification,
  type TitleCastMember,
} from "@/lib/tmdb-extras";

const BASE = "https://api.themoviedb.org/3";

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

    // Bound the request so a stalled TMDB response can't hang indefinitely
    // and bypass the retry/backoff below (which only triggers on rejection
    // or a non-2xx response).
    const timeoutSignal = AbortSignal.timeout(8000);
    init.signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;

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

export interface TmdbVideo {
  site: string;
  type: string;
  official?: boolean;
  key: string;
  name: string;
  published_at?: string;
}

// --- Title bundle: one append_to_response request ---------------------------
// A single /movie/{id} or /tv/{id} call carries everything the title page's
// extras need (videos, providers, recommendations, credits, external ids and a
// certification source) as nested keys, replacing 3-4 round trips with one.

/** A cast row on a movie `credits` response. */
export interface TmdbCastCredit {
  id: number;
  name: string;
  original_name?: string;
  character?: string;
  profile_path: string | null;
  order?: number;
  known_for_department?: string;
}

/** A crew row on a movie `credits` response. */
export interface TmdbCrewCredit {
  id: number;
  name: string;
  original_name?: string;
  job?: string;
  department?: string;
  profile_path: string | null;
}

export interface TmdbCredits {
  cast?: TmdbCastCredit[];
  crew?: TmdbCrewCredit[];
}

/** One credited role within a TV `aggregate_credits` cast row. */
export interface TmdbAggregateRole {
  credit_id?: string;
  character?: string;
  episode_count?: number;
}

/** One credited job within a TV `aggregate_credits` crew row. */
export interface TmdbAggregateJob {
  credit_id?: string;
  job?: string;
  episode_count?: number;
}

/** A cast row on a TV `aggregate_credits` response (roles are aggregated). */
export interface TmdbAggregateCastCredit {
  id: number;
  name: string;
  roles?: TmdbAggregateRole[];
  total_episode_count?: number;
  order?: number;
  profile_path: string | null;
}

/** A crew row on a TV `aggregate_credits` response (jobs are aggregated). */
export interface TmdbAggregateCrewCredit {
  id: number;
  name: string;
  jobs?: TmdbAggregateJob[];
  department?: string;
  total_episode_count?: number;
  profile_path: string | null;
}

export interface TmdbAggregateCredits {
  cast?: TmdbAggregateCastCredit[];
  crew?: TmdbAggregateCrewCredit[];
}

/** A single certification entry within a movie `release_dates` region result. */
export interface TmdbReleaseDate {
  certification: string;
  iso_639_1?: string;
  note?: string;
  release_date?: string;
  type?: number;
}

/** A per-region group of release dates on a movie `release_dates` response. */
export interface TmdbReleaseDatesResult {
  iso_3166_1: string;
  release_dates: TmdbReleaseDate[];
}

/** A per-region rating on a TV `content_ratings` response. */
export interface TmdbContentRating {
  iso_3166_1: string;
  rating: string;
  descriptors?: string[];
}

export interface TmdbExternalIds {
  imdb_id?: string | null;
  wikidata_id?: string | null;
  facebook_id?: string | null;
  instagram_id?: string | null;
  twitter_id?: string | null;
}

/** A TV `created_by` entry from the detail response. */
export interface TmdbCreatedBy {
  id: number;
  credit_id?: string;
  name: string;
  gender?: number;
  profile_path?: string | null;
}

/**
 * A /movie/{id} or /tv/{id} response with our append_to_response sub-objects
 * attached as nested keys. Every appended field is optional: TMDB omits an
 * append entirely when the title has no data for it.
 */
interface TmdbAppendedDetail {
  id: number;
  imdb_id?: string | null;
  created_by?: TmdbCreatedBy[];
  videos?: { results?: TmdbVideo[] };
  "watch/providers"?: { results?: Record<string, TmdbRegionProviders> };
  recommendations?: TmdbPage<TmdbSearchItem>;
  credits?: TmdbCredits;
  aggregate_credits?: TmdbAggregateCredits;
  external_ids?: TmdbExternalIds;
  release_dates?: { results?: TmdbReleaseDatesResult[] };
  content_ratings?: { results?: TmdbContentRating[] };
}

/** Normalized, render-ready payload for the title page's extras. */
export interface TitleBundle {
  /** Raw provider results keyed by region — feed to regionWatchInfo(results, region). */
  providersResults: Record<string, TmdbRegionProviders> | undefined;
  /** Related titles, media_type-tagged, with the /similar fallback already applied. */
  related: TmdbSearchItem[];
  /** Raw videos — feed to pickTrailer(videos). */
  videos: TmdbVideo[];
  /**
   * Age/content certification for the viewer's streaming region (falls back
   * to any region with data), or null.
   */
  certification: string | null;
  /** Top-billed cast, ordered by billing and capped. */
  topCast: TitleCastMember[];
  /** Director(s) for movies; empty for TV. */
  directors: string[];
  /** Creator(s) for TV; empty for movies. */
  creators: string[];
  /** Canonical IMDb URL, or null when TMDB has no imdb_id. */
  imdbUrl: string | null;
}

/**
 * Everything the title page's below-the-fold extras need, in ONE TMDB request.
 * Appends videos, watch/providers, recommendations, credits (aggregate_credits
 * for TV), external_ids and the per-kind certification source onto the detail
 * response. Only when recommendations come back empty do we spend a second
 * request on /similar — matching the old recommendations -> similar fallback,
 * so worst case is 2 calls and the typical case is 1 (down from 3-4).
 *
 * `region` localizes the certification badge to the viewer's streaming region
 * (the same picker that scopes watch providers); it does not affect the fetch
 * URL, so the 24h response cache stays shared across regions.
 */
export async function getTitleBundle(
  kind: "movie" | "tv",
  id: number,
  region = "US",
): Promise<TitleBundle> {
  const appends =
    kind === "movie"
      ? "videos,watch/providers,recommendations,credits,external_ids,release_dates"
      : "videos,watch/providers,recommendations,aggregate_credits,external_ids,content_ratings";

  const data = await tmdb<TmdbAppendedDetail>(
    `/${kind}/${id}`,
    { language: "en-US", append_to_response: appends },
    { revalidate: 60 * 60 * 24 },
  );

  // Recommendations ride along in the bundle; only when they're empty do we
  // spend one more request on /similar so regional titles aren't left blank.
  let relatedRaw = data.recommendations?.results ?? [];
  if (relatedRaw.length === 0) {
    const sim = await tmdb<TmdbPage<TmdbSearchItem>>(
      `/${kind}/${id}/similar`,
      { language: "en-US" },
      { revalidate: 60 * 60 * 24 },
    ).catch(() => null);
    relatedRaw = sim?.results ?? [];
  }
  const related = relatedRaw.map((r) => ({ ...r, media_type: kind }));

  const credits = kind === "movie" ? data.credits : data.aggregate_credits;

  return {
    providersResults: data["watch/providers"]?.results,
    related,
    videos: data.videos?.results ?? [],
    certification:
      kind === "movie"
        ? pickMovieCertification(data.release_dates?.results, region)
        : pickTvCertification(data.content_ratings?.results, region),
    topCast: pickTopCast(credits),
    directors: kind === "movie" ? pickDirector(data.credits) : [],
    creators:
      kind === "tv" ? pickCreators(data.created_by, data.aggregate_credits?.crew) : [],
    imdbUrl: imdbUrl(data.external_ids),
  };
}
