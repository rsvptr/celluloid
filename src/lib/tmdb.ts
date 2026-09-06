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
// tmdb-match imports only a TYPE from this module, so there is no runtime cycle.
// Reusing its normalizer keeps "does this page contain the title we asked for?"
// answered the same way the matcher will answer it.
import { norm } from "@/lib/tmdb-match";

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

export interface TmdbOptions {
  /** Next.js cache revalidation seconds (ignored outside Next). */
  revalidate?: number;
  retries?: number;
  /**
   * Wall-clock budget for the whole call, retries and backoff included. The
   * per-attempt timeout below only bounds one attempt, so a call that keeps
   * timing out would otherwise run ~47s — and getTitleBundle, which can make
   * two calls, twice that — past a route's maxDuration.
   */
  deadlineMs?: number;
  /** Caller cancellation: aborts the in-flight request and stops retrying. */
  signal?: AbortSignal;
}

/**
 * Whether another attempt is worth making: retries left, the caller still
 * wants the result, and the overall budget has room for one more.
 */
function shouldRetry(
  attempt: number,
  retries: number,
  deadline: number,
  signal?: AbortSignal,
): boolean {
  return attempt < retries && !signal?.aborted && Date.now() < deadline;
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
  const deadline = Date.now() + (opts.deadlineMs ?? 15000);
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new DOMException("TMDB request deadline exceeded.", "TimeoutError");
    }
    const init: FetchInit = {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        accept: "application/json",
      },
    };
    if (opts.revalidate !== undefined) init.next = { revalidate: opts.revalidate };

    // Bound the request so a stalled TMDB response can't hang indefinitely
    // and bypass the retry/backoff below (which only triggers on rejection
    // or a non-2xx response). The caller's own signal rides alongside it so a
    // cancelled run stops paying for TMDB work already in flight.
    const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(8000, remaining)));
    init.signal = opts.signal
      ? AbortSignal.any([opts.signal, timeoutSignal])
      : timeoutSignal;

    let res: Response;
    try {
      res = await fetch(url, init);
      // The body read belongs inside the retried region: a connection dropped
      // mid-body rejects here, and that is every bit as transient as a failed
      // connect. Read after the catch, such a failure escaped unretried.
      if (res.ok) return (await res.json()) as T;
    } catch (err) {
      if (shouldRetry(attempt, retries, deadline, opts.signal)) {
        await sleepWithinBudget(400 * 2 ** attempt, deadline, opts.signal);
        continue;
      }
      throw err;
    }

    // Back off on rate limits / transient server errors. Cap the honored
    // Retry-After so a pathological header can't stall a serverless function
    // for its whole timeout budget.
    if (
      (res.status === 429 || res.status >= 500) &&
      shouldRetry(attempt, retries, deadline, opts.signal)
    ) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, 5000);
      await sleepWithinBudget(wait, deadline, opts.signal);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`TMDB ${res.status} on ${path}: ${body.slice(0, 200)}`);
  }
}

function sleepWithinBudget(ms: number, deadline: number, signal?: AbortSignal) {
  const remaining = deadline - Date.now();
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (remaining <= 0) {
    return Promise.reject(new DOMException("TMDB request deadline exceeded.", "TimeoutError"));
  }
  const wait = Math.min(ms, remaining);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, wait);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
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
  opts: Pick<TmdbOptions, "deadlineMs" | "retries" | "signal"> = {},
): Promise<(TmdbSearchItem & { media_type: "movie" | "tv" })[]> {
  if (!query.trim()) return [];
  const data = await tmdb<TmdbPage<TmdbSearchItem>>(
    "/search/multi",
    { query, page, include_adult: false, language: "en-US" },
    { revalidate: 60 * 60, ...opts },
  );
  return data.results.filter(
    (r): r is TmdbSearchItem & { media_type: "movie" | "tv" } =>
      r.media_type === "movie" || r.media_type === "tv",
  );
}

/** Per-search refinements: the year filter and caller cancellation. */
export interface SearchOptions {
  /**
   * Release year (movies) or first-air year (TV). TMDB ranks by popularity, so
   * an unfiltered title search resolves to whichever entry is better known —
   * "Drishyam" 2013 lands on the 2015 remake — and the wrong tmdbId then trips
   * @@unique([userId, mediaType, tmdbId]) when the real title is added.
   */
  year?: number | null;
  signal?: AbortSignal;
  deadlineMs?: number;
  retries?: number;
}

export async function searchByType(
  kind: "movie" | "tv",
  query: string,
  page = 1,
  opts: SearchOptions = {},
): Promise<TmdbSearchItem[]> {
  if (!query.trim()) return [];
  const base = { query, page, include_adult: false, language: "en-US" };
  // /search/movie takes primary_release_year; /search/tv takes
  // first_air_date_year. The generic `year` both accept is looser (TV matches
  // any episode's air date), so use the precise one per kind.
  const yearKey = kind === "movie" ? "primary_release_year" : "first_air_date_year";
  const run = (year?: number) =>
    tmdb<TmdbPage<TmdbSearchItem>>(
      `/search/${kind}`,
      year === undefined ? base : { ...base, [yearKey]: year },
      {
        revalidate: 60 * 60,
        signal: opts.signal,
        deadlineMs: opts.deadlineMs,
        retries: opts.retries,
      },
    );

  const year = opts.year ?? undefined;
  let results = (await run(year)).results;

  // The filter is exact and the year we hold comes from a spreadsheet or from
  // the model, either of which can simply be wrong — a festival year against a
  // wide release, or the year the owner watched it rather than the year it came
  // out. Retrying only on an EMPTY page was not enough: an off-by-one year
  // usually returns a populated page that just doesn't contain the right title,
  // and the caller's matcher will then settle for a partial name overlap — a
  // confidently wrong tmdbId, poster and year, which for "add to library" means
  // adding the wrong film. So retry whenever nothing on the filtered page
  // actually carries the queried name, and hand the matcher BOTH sets with the
  // year-filtered ones first, so it can still prefer them on an even score.
  if (year !== undefined) {
    const wanted = norm(query);
    const hasNameMatch = results.some(
      (r) => norm(r.title ?? r.name ?? "") === wanted,
    );
    if (!hasNameMatch) {
      const seen = new Set(results.map((r) => r.id));
      const unfiltered = (await run()).results.filter((r) => !seen.has(r.id));
      results = [...results, ...unfiltered];
    }
  }

  return results.map((r) => ({ ...r, media_type: kind }));
}

/**
 * Shape of `/find/{external_id}`. TMDB returns one array per object kind; only
 * the two we can import are declared, and `media_type` is stamped by the caller
 * below rather than trusted (it is documented on movie results but not on the
 * TV ones).
 */
interface TmdbFindResponse {
  movie_results?: TmdbSearchItem[];
  tv_results?: TmdbSearchItem[];
}

/**
 * Resolve an IMDb id ("tt0110912") to its TMDB entries. An external id is an
 * exact identity, so a spreadsheet that carries one never has to go through the
 * fuzzy name search — which is where a large import loses most of its accuracy.
 * Returns movies first, then TV; an unknown or malformed id yields an empty
 * list rather than an error, since a bad cell is the caller's normal case.
 */
export async function findByImdbId(
  imdbId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TmdbSearchItem[]> {
  const id = imdbId.trim();
  if (!/^tt\d{5,12}$/i.test(id)) return [];
  const data = await tmdb<TmdbFindResponse>(
    `/find/${encodeURIComponent(id)}`,
    { external_source: "imdb_id", language: "en-US" },
    { revalidate: 60 * 60 * 24, signal: opts.signal },
  );
  return [
    ...(data.movie_results ?? []).map((r) => ({ ...r, media_type: "movie" as const })),
    ...(data.tv_results ?? []).map((r) => ({ ...r, media_type: "tv" as const })),
  ];
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
  /** Region-specific ordering returned by the provider-catalogue endpoints. */
  display_priorities?: Record<string, number>;
}

interface TmdbProviderCatalogue {
  results?: TmdbProvider[];
}

/**
 * Merge the movie and TV catalogues into one stable picker list.
 *
 * TMDB returns the same service from both endpoints and occasionally gives the
 * two rows different priorities. Keep one row per provider id, preserve any
 * logo either row supplied, and use the best regional priority so familiar
 * services stay near the top of Settings.
 */
export function mergeWatchProviderCatalogues(
  catalogues: readonly (readonly TmdbProvider[])[],
  region: string,
): TmdbProvider[] {
  const byId = new Map<number, TmdbProvider>();

  for (const catalogue of catalogues) {
    for (const provider of catalogue) {
      if (!Number.isInteger(provider.provider_id) || provider.provider_id <= 0) continue;
      const priority =
        provider.display_priorities?.[region] ?? provider.display_priority ?? Number.MAX_SAFE_INTEGER;
      const existing = byId.get(provider.provider_id);
      if (!existing) {
        byId.set(provider.provider_id, { ...provider, display_priority: priority });
        continue;
      }

      const existingPriority = existing.display_priority ?? Number.MAX_SAFE_INTEGER;
      const preferred = priority < existingPriority ? provider : existing;
      byId.set(provider.provider_id, {
        ...preferred,
        logo_path: preferred.logo_path ?? existing.logo_path ?? provider.logo_path,
        display_priority: Math.min(priority, existingPriority),
      });
    }
  }

  return [...byId.values()].sort(
    (a, b) =>
      (a.display_priority ?? Number.MAX_SAFE_INTEGER) -
        (b.display_priority ?? Number.MAX_SAFE_INTEGER) ||
      a.provider_name.localeCompare(b.provider_name) ||
      a.provider_id - b.provider_id,
  );
}

/**
 * Region-appropriate services for the Settings picker. Provider catalogues
 * change much less often than title availability, so a one-day cache keeps the
 * picker quick without making renamed/new services linger for long.
 */
export async function getWatchProviders(region: string): Promise<TmdbProvider[]> {
  if (!/^[A-Z]{2}$/.test(region)) throw new Error("Invalid TMDB watch region.");

  const params = { language: "en-US", watch_region: region };
  const [movies, tv] = await Promise.all([
    tmdb<TmdbProviderCatalogue>("/watch/providers/movie", params, {
      revalidate: 60 * 60 * 24,
    }),
    tmdb<TmdbProviderCatalogue>("/watch/providers/tv", params, {
      revalidate: 60 * 60 * 24,
    }),
  ]);

  return mergeWatchProviderCatalogues([movies.results ?? [], tv.results ?? []], region);
}

/**
 * TMDB ids for a genre named in the app (Title.genres stores TMDB's display
 * names, so the match is by name, case-insensitively). Both catalogues are
 * consulted because one name can carry different ids per medium ("Action &
 * Adventure" is TV-only; movie "Action" is a different id). The lists are
 * near-static, so a one-day cache is plenty. Returns every matching id across
 * the requested kinds; empty means TMDB doesn't know the name at all.
 */
export async function getGenreIdsByName(
  name: string,
  kinds: ReadonlyArray<"movie" | "tv">,
): Promise<Set<number>> {
  const wanted = name.trim().toLowerCase();
  const lists = await Promise.all(
    kinds.map((kind) =>
      tmdb<{ genres: TmdbGenre[] }>(`/genre/${kind}/list`, { language: "en-US" }, {
        revalidate: 60 * 60 * 24,
      }),
    ),
  );
  const ids = new Set<number>();
  for (const list of lists) {
    for (const genre of list.genres ?? []) {
      if (genre.name.toLowerCase() === wanted) ids.add(genre.id);
    }
  }
  return ids;
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
