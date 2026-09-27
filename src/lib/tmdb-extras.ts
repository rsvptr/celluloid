// Pure, client-safe helpers for the title-page extras (watch providers,
// trailer, streaming region). No fetching here — testable logic only.

import type {
  TmdbContentRating,
  TmdbProvider,
  TmdbRegionProviders,
  TmdbReleaseDatesResult,
  TmdbVideo,
} from "@/lib/tmdb";

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
  /**
   * TMDB's watch page for this title in this region, which links on to each
   * service. The availability data is JustWatch's, so that attribution stays.
   */
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

// --- Title enrichment: certification, cast, crew, IMDb ----------------------
// Pure parsers over the sub-objects TMDB appends to a detail response. They
// accept loose, partial shapes because any append can be missing for a given
// title, and stay free of I/O so they unit-test without a network.

/** A person in the "Top cast" strip, already flattened for rendering. */
export interface TitleCastMember {
  name: string;
  character: string;
  profilePath: string | null;
}

/** Structural cast row shared by movie `credits.cast` and TV `aggregate_credits.cast`. */
export interface CastCreditLike {
  name?: string;
  /** Movie credits carry the role here. */
  character?: string | null;
  /** TV aggregate credits carry roles as an array; character is roles[0].character. */
  roles?: { character?: string | null }[];
  profile_path?: string | null;
  order?: number;
}

/** Structural crew row shared by movie `credits.crew` and TV `aggregate_credits.crew`. */
export interface CrewCreditLike {
  name?: string;
  /** Movie credits carry a single job. */
  job?: string | null;
  /** TV aggregate credits carry an array of jobs. */
  jobs?: { job?: string | null }[];
}

/** A TV `created_by` entry. */
export interface CreatedByLike {
  name?: string;
}

/** An `external_ids` sub-object (only the id we use is required). */
export interface ExternalIdsLike {
  imdb_id?: string | null;
}

/** First non-empty, trimmed certification among a region's release dates. */
function firstMovieCert(result: TmdbReleaseDatesResult | undefined): string | null {
  for (const rd of result?.release_dates ?? []) {
    const cert = rd.certification?.trim();
    if (cert) return cert;
  }
  return null;
}

/** An age rating and the country whose board issued it. */
export interface Certification {
  rating: string;
  /** ISO 3166-1 code of the issuing country. */
  region: string;
}

/**
 * Where to look for a rating, in order: the viewer's region, then the title's
 * own countries (a regional film is rated at home even when the viewer's
 * country never rated it), then the US. Any other region comes after.
 */
function certificationRegions(region: string, origin: readonly string[]): string[] {
  return [...new Set([region, ...origin, "US"])];
}

/**
 * Pick a movie's age rating from `release_dates.results`: `region` (default
 * US), then the title's `origin` countries, then the US, then any region with a
 * non-empty certification. TMDB lists regions alphabetically, so "any" alone
 * showed a US viewer Spain's rating for an Indian film. The issuing region is
 * returned so the page can say whose rating it is.
 */
export function pickMovieCertification(
  results: TmdbReleaseDatesResult[] | null | undefined,
  region = "US",
  origin: readonly string[] = [],
): Certification | null {
  if (!results?.length) return null;
  for (const code of certificationRegions(region, origin)) {
    const rating = firstMovieCert(results.find((r) => r.iso_3166_1 === code));
    if (rating) return { rating, region: code };
  }
  for (const r of results) {
    const rating = firstMovieCert(r);
    if (rating) return { rating, region: r.iso_3166_1 };
  }
  return null;
}

/**
 * Pick a TV show's age rating from `content_ratings.results`, in the same
 * order as pickMovieCertification.
 */
export function pickTvCertification(
  results: TmdbContentRating[] | null | undefined,
  region = "US",
  origin: readonly string[] = [],
): Certification | null {
  if (!results?.length) return null;
  for (const code of certificationRegions(region, origin)) {
    const rating = results.find((r) => r.iso_3166_1 === code)?.rating?.trim();
    if (rating) return { rating, region: code };
  }
  for (const r of results) {
    const rating = r.rating?.trim();
    if (rating) return { rating, region: r.iso_3166_1 };
  }
  return null;
}

/**
 * Top-billed cast for the "Cast" strip. Works for both movie `credits.cast`
 * (character in `character`) and TV `aggregate_credits.cast` (character in
 * `roles[0].character`). Sorted by billing `order` ascending, capped at `limit`.
 */
export function pickTopCast(
  credits: { cast?: CastCreditLike[] } | null | undefined,
  limit = 8,
): TitleCastMember[] {
  const cast = credits?.cast ?? [];
  return cast
    .filter((c) => (c.name ?? "").trim().length > 0)
    .sort(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER),
    )
    .slice(0, Math.max(0, limit))
    .map((c) => ({
      name: (c.name ?? "").trim(),
      character: (c.character ?? c.roles?.[0]?.character ?? "").trim(),
      profilePath: c.profile_path ?? null,
    }));
}

/** De-duplicate a list of names, dropping blanks, preserving first-seen order. */
function dedupeNames(names: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** Director name(s) from movie `credits.crew` (job === "Director"). */
export function pickDirector(
  credits: { crew?: CrewCreditLike[] } | null | undefined,
): string[] {
  const directors = (credits?.crew ?? [])
    .filter((c) => c.job === "Director" || c.jobs?.some((j) => j.job === "Director"))
    .map((c) => c.name);
  return dedupeNames(directors);
}

/**
 * TV creator name(s). Uses the details `created_by` array when present,
 * otherwise falls back to crew whose job looks like a creator credit.
 */
export function pickCreators(
  createdBy: CreatedByLike[] | null | undefined,
  crew?: CrewCreditLike[] | null,
): string[] {
  const fromCreatedBy = dedupeNames((createdBy ?? []).map((c) => c.name));
  if (fromCreatedBy.length) return fromCreatedBy;

  const isCreatorJob = (job: string | null | undefined) => !!job && /creator/i.test(job);
  const fromCrew = (crew ?? [])
    .filter((c) => isCreatorJob(c.job) || c.jobs?.some((j) => isCreatorJob(j.job)))
    .map((c) => c.name);
  return dedupeNames(fromCrew);
}

/** Canonical IMDb title URL from an `external_ids` sub-object, or null. */
export function imdbUrl(externalIds: ExternalIdsLike | null | undefined): string | null {
  const id = externalIds?.imdb_id?.trim();
  return id ? `https://www.imdb.com/title/${id}/` : null;
}
