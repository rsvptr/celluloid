import "server-only";
import { prisma } from "@/lib/prisma";
import {
  MediaType,
  MetadataSyncState,
  WatchStatus,
  type Prisma,
} from "@/generated/prisma/client";
import {
  appendedSeasons,
  MAX_APPENDED_SEASONS,
  TMDB_API_BASE,
  TmdbError,
  tmdbErrorCode,
  type TmdbEpisode,
  type TmdbRegionProviders,
  type TmdbSeasonDetails,
} from "@/lib/tmdb";
import { DEFAULT_WATCH_REGION, isWatchRegion } from "@/lib/tmdb-extras";
import { mapLimit } from "@/lib/async";
import { env } from "@/lib/env";
import {
  ACTIVE_EPISODE_FILTER,
  chunks,
  deriveNextEpisodeAirDate,
  discoveredAtForNewEpisode,
  WITHDRAWN_EPISODE_NUMBER_OFFSET,
} from "@/lib/rematch-history";
export { deriveNextEpisodeAirDate, discoveredAtForNewEpisode } from "@/lib/rematch-history";

/**
 * Scheduled TMDB metadata refresh.
 *
 * Nothing re-fetched TMDB after a title was added, so a tracked show that aired
 * a new season stayed frozen at whatever it looked like on the day it entered
 * the library. The "New episodes" badge keys on Episode.discoveredAt, which
 * only ever moved when the owner manually refreshed a title — so in practice
 * the badge never fired for the case it exists to cover. This module is the
 * missing half: it walks the least-recently-synced shows and materializes
 * newly aired episodes, which is what makes that signal real.
 *
 * The rules that matter here:
 *   - Episodes are UPSERTED by TMDB id, falling back to their coordinate only
 *     for legacy rows without one. A withdrawn unwatched row is deleted; a
 *     watched row keeps its identity and history with a withdrawnAt stamp.
 *   - A row this run does create is dated by its own air date rather than by
 *     the run, so materializing a back catalogue is not mistaken for a night of
 *     new episodes. See discoveredAtForNewEpisode.
 *   - TMDB renumbering is applied in two phases so coordinate swaps cannot trip
 *     the `(seasonId, episodeNumber)` unique constraint or move a watched tick
 *     onto a different TMDB episode.
 *   - One title's failure is recorded on that title and the run continues.
 */

// --- TMDB access ------------------------------------------------------------
//
// This module does its own fetching rather than calling lib/tmdb's getTv /
// getSeasons. Those wrappers cache responses for 24h, which is right for the
// interactive paths but wrong here: on a daily cadence a still-warm entry means
// the sync reads yesterday's answer to "did anything air?" — the one question
// it exists to ask. lib/tmdb's fetcher is module-private and its caching is
// baked into each endpoint wrapper, so there is no way to opt out from outside
// it. Response TYPES and the API root are still imported from there, so the
// shapes and the base URL stay in one place.

/** Bound one attempt so a stalled TMDB response can't eat the run's budget. */
const TMDB_TIMEOUT_MS = 8000;
const EPISODE_RENUMBER_OFFSET = 1_000_000;

/**
 * Raised when the run's wall-clock budget ran out before a request could be
 * made. Deliberately distinct from a TMDB failure: nothing is wrong with a
 * title that merely ran out of time, so the run leaves its `metadataSyncedAt`
 * alone — which keeps it at the head of the queue for tomorrow — instead of
 * stamping it FAILED and sending it to the back.
 */
class SyncBudgetExhaustedError extends Error {
  constructor(path: string) {
    super(`Run budget exhausted before ${path}`);
    this.name = "SyncBudgetExhaustedError";
  }
}

/** The title-level fields the sync reads off /movie/{id} or /tv/{id}. */
interface TmdbTitleSyncDetail {
  id: number;
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number | null;
  genres?: { name: string }[] | null;
  /** Movies. */
  release_date?: string | null;
  runtime?: number | null;
  /** TV. `episode_run_time` is empty for most current shows. */
  first_air_date?: string | null;
  episode_run_time?: number[] | null;
  /** TMDB's lifecycle string: "Returning Series", "Ended", "Canceled", ... */
  status?: string | null;
  "watch/providers"?: { results?: Record<string, TmdbRegionProviders> };
}

/** The fields the sync reads off /tv/{id}; a superset of TmdbTvDetails. */
interface TmdbTvSyncDetail extends TmdbTitleSyncDetail {
  name?: string;
  number_of_seasons?: number | null;
  next_episode_to_air?: { air_date?: string | null } | null;
  seasons?: TmdbSeasonSummary[];
}

/** The compact season rows included in TMDB's TV-detail response. */
export interface TmdbSeasonSummary {
  /** The season's TMDB id, which appended season details omit. */
  id: number;
  season_number: number;
  episode_count?: number | null;
  air_date?: string | null;
}

/**
 * `deadline` is epoch milliseconds and bounds the whole call — every attempt
 * and every backoff — the way lib/tmdb's `deadlineMs` bounds its own. Without
 * it the run deadline gated only whether a title STARTED, so a show with
 * hundreds of episodes could begin a millisecond under the wire and then spend
 * a full per-attempt timeout on each of its season requests, running long past
 * the function's duration limit until the platform killed it mid-run.
 */
async function tmdbGet<T>(
  path: string,
  params: Record<string, string>,
  deadline: number,
): Promise<T> {
  const token = env.TMDB_ACCESS_TOKEN;
  const url = new URL(TMDB_API_BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  // Two attempts, not the four lib/tmdb allows: a title that loses a transient
  // blip is picked up by tomorrow's run (it keeps its place at the front of the
  // queue), and a long retry ladder across ~50 titles would outlast the
  // function's own duration limit.
  for (let attempt = 0; ; attempt++) {
    // Each attempt inherits what is left of the budget rather than a fresh
    // TMDB_TIMEOUT_MS, so a title in flight when the deadline passes stops
    // paying for TMDB work instead of finishing at its own pace.
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SyncBudgetExhaustedError(path);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(TMDB_TIMEOUT_MS, remaining)),
        // The whole point of this module is to see today's data, not a cached
        // copy of the answer it is checking for change.
        cache: "no-store",
      });
      // The body read shares that signal, so it belongs under the same guard as
      // the request itself — an abort part-way through a body is the same event.
      if (res.ok) return (await res.json()) as T;
    } catch (err) {
      // One signal serves both the per-attempt timeout and the run budget, so
      // the clock is what tells the two aborts apart: past the deadline this is
      // the budget stopping the title, not TMDB failing it.
      if (Date.now() >= deadline) throw new SyncBudgetExhaustedError(path);
      // A thrown fetch — timeout, DNS, TLS, connection reset — is every bit as
      // transient as the 429/5xx handled below, but it used to fail the title
      // on the spot, so "two attempts" was only half-kept: a status-code blip
      // got its retry while a transport blip did not. Same single retry, and
      // only when the budget can pay for the backoff.
      if (attempt < 1 && Date.now() + 800 < deadline) {
        await sleep(800);
        continue;
      }
      throw err;
    }
    if (isTransientStatus(res.status) && attempt < 1) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 800, 3000);
      // Only sleep on a retry the budget can actually pay for; otherwise fall
      // through and report the TMDB status, which is the real failure.
      if (Date.now() + wait < deadline) {
        await sleep(wait);
        continue;
      }
    }
    const code = tmdbErrorCode(await res.text().catch(() => ""));
    throw new TmdbError(
      res.status,
      code,
      `TMDB ${res.status}${code === null ? "" : ` (code ${code})`} on ${path}`,
    );
  }
}

/** Rate limiting and server errors: TMDB having a bad moment, not a bad title. */
function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * TMDB rejected the token itself (401: code 7 invalid key, code 10 suspended).
 * Every request in the run fails the same way, so it is a run-level failure.
 */
function isAuthFailure(err: unknown): boolean {
  return err instanceof TmdbError && err.status === 401;
}

/** Recorded for a title TMDB answers 404 for (code 34): removed or merged. */
const REMOVED_FROM_TMDB_MESSAGE =
  "TMDB no longer lists this title. Use Change match to pick its current entry.";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function fetchTvDetail(tmdbId: number, deadline: number): Promise<TmdbTvSyncDetail> {
  return tmdbGet<TmdbTvSyncDetail>(
    `/tv/${tmdbId}`,
    {
      language: "en-US",
      // Providers ride along on the detail request — a second round trip per
      // title, times ~50 titles a night, for data this small is not worth it.
      append_to_response: "watch/providers",
    },
    deadline,
  );
}

/** Up to MAX_APPENDED_SEASONS seasons in one request, ids from the show's season list. */
async function fetchSeasons(
  tmdbId: number,
  seasons: TmdbSeasonSummary[],
  deadline: number,
): Promise<TmdbSeasonDetails[]> {
  const response = await tmdbGet<Record<string, unknown>>(
    `/tv/${tmdbId}`,
    {
      language: "en-US",
      append_to_response: seasons.map((s) => `season/${s.season_number}`).join(","),
    },
    deadline,
  );
  return appendedSeasons(response, seasons).map(({ sd }) => sd);
}

/**
 * One request for a title that needs no season data: its details, with
 * providers riding along. It costs the same single request as the bare
 * /watch/providers call it replaced, and it is the only refresh movies get, so
 * a moved release date, a new poster or a settled rating reaches them too.
 */
function fetchDetailWithProviders(
  mediaType: MediaType,
  tmdbId: number,
  deadline: number,
): Promise<TmdbTitleSyncDetail> {
  const kind = mediaType === MediaType.TV ? "tv" : "movie";
  return tmdbGet<TmdbTitleSyncDetail>(
    `/${kind}/${tmdbId}`,
    { language: "en-US", append_to_response: "watch/providers" },
    deadline,
  );
}

// --- Candidate selection ----------------------------------------------------

/**
 * TMDB lifecycle strings that mean "this show will not air again". A title in
 * one of these states is only re-synced while the owner is still working
 * through it; a finished show they have already watched has nothing left to
 * discover. Stored verbatim from TMDB, so both spellings of "cancelled" are
 * listed rather than trusting one.
 */
const FINISHED_TMDB_STATUSES = ["Ended", "Canceled", "Cancelled"];

/** Statuses that mean the owner is still working through the show. */
const ACTIVE_STATUSES: WatchStatus[] = [
  WatchStatus.WATCHING,
  WatchStatus.WATCHLIST,
  WatchStatus.ON_HOLD,
];

/** Default ceiling on titles touched in a single run. */
export const DEFAULT_SYNC_LIMIT = 50;

/** How many titles are refreshed at once. Each holds one row lock, briefly. */
const DEFAULT_CONCURRENCY = 4;

/** How many season requests one title may have in flight. Mirrors lib/actions. */
const SEASON_CONCURRENCY = 6;

interface SyncCandidate {
  id: string;
  tmdbId: number;
  name: string;
  mediaType: MediaType;
  kind: "TV_METADATA" | "PROVIDERS_ONLY";
  /** Oldest cache this operation will refresh; used to merge the two queues fairly. */
  dueAt: number;
  /** Immutable, and the date back-catalogue episodes are dated to. See upsertSeasons. */
  createdAt: Date;
  /** Local summaries used to avoid re-fetching every historical TV season. */
  seasons: StoredSeasonSummary[];
  /** Region attached to provider ids before a provider-only refresh. */
  providersRegion?: string | null;
  /** The last recorded metadata outcome; decides whether a transient failure keeps its place. */
  metadataSyncState?: MetadataSyncState | null;
}

/** Everything the candidate query needs beyond the sync-state split below. */
function metadataCandidateWhere(userId: string): Prisma.TitleWhereInput {
  return {
    userId,
    deletedAt: null,
    mediaType: MediaType.TV,
    tmdbId: { not: null },
    // A dropped show is one the owner decided to stop hearing about; new
    // episodes for it are noise, so it is never a candidate regardless of
    // what TMDB says about the show still running.
    status: { not: WatchStatus.DROPPED },
    OR: [
      { status: { in: ACTIVE_STATUSES } },
      // Never synced — we have no lifecycle string yet, so we cannot rule it out.
      { tmdbStatus: null },
      // Finished-and-watched shows drop out here; a watched show that TMDB
      // still lists as returning stays in, which is how a surprise new
      // season gets noticed at all.
      { tmdbStatus: { notIn: FINISHED_TMDB_STATUSES } },
    ],
  };
}

const METADATA_CANDIDATE_SELECT = {
  id: true,
  tmdbId: true,
  name: true,
  createdAt: true,
  mediaType: true,
  metadataSyncedAt: true,
  metadataSyncState: true,
  seasons: {
    where: { seasonNumber: { gte: 1 } },
    orderBy: { seasonNumber: "asc" },
    select: { seasonNumber: true, episodeCount: true, airDate: true },
  },
} as const;

const PROVIDER_CANDIDATE_SELECT = {
  id: true,
  tmdbId: true,
  name: true,
  createdAt: true,
  mediaType: true,
  providersSyncedAt: true,
  providersRegion: true,
} as const;

/**
 * The titles this run will refresh, least-recently-synced first.
 *
 * Never-synced titles come from their own query rather than from a single
 * `nulls: "first"` ordering. Postgres btree indexes are built ASC NULLS LAST,
 * so `ORDER BY "metadataSyncedAt" ASC NULLS FIRST` cannot be served by
 * `Title(userId, metadataSyncedAt)` at all — the index the column was added
 * for — and the planner sorted the whole matching set on every run instead.
 * Prisma cannot express a NULLS FIRST index, so the query is what bends: split
 * in two, the first is an equality match on both index columns and the second's
 * ordering is the index's own, while "never synced first" simply falls out of
 * running them in that order. The id tiebreak keeps the rotation stable between
 * runs when a batch shares a timestamp.
 */
async function selectMetadataCandidates(
  userId: string,
  limit: number,
): Promise<SyncCandidate[]> {
  const where = metadataCandidateWhere(userId);

  const neverSynced = await prisma.title.findMany({
    where: { ...where, metadataSyncedAt: null },
    orderBy: { id: "asc" },
    take: limit,
    select: METADATA_CANDIDATE_SELECT,
  });

  const rows =
    neverSynced.length >= limit
      ? neverSynced
      : [
          ...neverSynced,
          ...(await prisma.title.findMany({
            where: { ...where, metadataSyncedAt: { not: null } },
            orderBy: [{ metadataSyncedAt: "asc" }, { id: "asc" }],
            take: limit - neverSynced.length,
            select: METADATA_CANDIDATE_SELECT,
          })),
        ];

  // tmdbId is non-null by the filter above; the narrowing keeps that provable.
  return rows.flatMap((r) =>
    r.tmdbId === null
      ? []
      : [
          {
            id: r.id,
            tmdbId: r.tmdbId,
            name: r.name,
            createdAt: r.createdAt,
            mediaType: r.mediaType,
            kind: "TV_METADATA" as const,
            dueAt: r.metadataSyncedAt?.getTime() ?? 0,
            seasons: r.seasons,
            metadataSyncState: r.metadataSyncState,
          },
        ],
  );
}

/**
 * Matched live titles whose provider cache should rotate through the nightly run.
 * Missing and wrong-region rows go first because their current cache cannot
 * answer the active device at all; correct-region rows then rotate oldest first.
 */
async function selectProviderCandidates(
  userId: string,
  region: string,
  limit: number,
): Promise<SyncCandidate[]> {
  const where = providerCandidateWhere(userId);

  const missing = await prisma.title.findMany({
    where: { ...where, providersSyncedAt: null },
    orderBy: { id: "asc" },
    take: limit,
    select: PROVIDER_CANDIDATE_SELECT,
  });
  const afterMissing = limit - missing.length;
  const wrongRegion =
    afterMissing <= 0
      ? []
      : await prisma.title.findMany({
          where: {
            ...where,
            providersSyncedAt: { not: null },
            OR: [{ providersRegion: null }, { providersRegion: { not: region } }],
          },
          orderBy: [{ providersSyncedAt: "asc" }, { id: "asc" }],
          take: afterMissing,
          select: PROVIDER_CANDIDATE_SELECT,
        });
  const afterWrongRegion = afterMissing - wrongRegion.length;
  const currentRegion =
    afterWrongRegion <= 0
      ? []
      : await prisma.title.findMany({
          where: {
            ...where,
            providersSyncedAt: { not: null },
            providersRegion: region,
          },
          orderBy: [{ providersSyncedAt: "asc" }, { id: "asc" }],
          take: afterWrongRegion,
          select: PROVIDER_CANDIDATE_SELECT,
        });

  return [...missing, ...wrongRegion, ...currentRegion].flatMap((row) =>
    row.tmdbId === null
      ? []
      : [
          {
            id: row.id,
            tmdbId: row.tmdbId,
            name: row.name,
            createdAt: row.createdAt,
            mediaType: row.mediaType,
            kind: "PROVIDERS_ONLY" as const,
            seasons: [],
            providersRegion: row.providersRegion,
            // Wrong-region data is unusable regardless of how recently it was
            // fetched, so it shares the never-synced front of the queue.
            dueAt:
              row.providersSyncedAt === null || row.providersRegion !== region
                ? 0
                : row.providersSyncedAt.getTime(),
          },
        ],
  );
}

/** All matched live titles that are eligible for a provider-cache refresh. */
export function providerCandidateWhere(userId: string): Prisma.TitleWhereInput {
  return {
    userId,
    deletedAt: null,
    tmdbId: { not: null },
    mediaType: { in: [MediaType.MOVIE, MediaType.TV] },
    status: { not: WatchStatus.DROPPED },
  };
}

/**
 * Merge metadata and provider rotations under one title limit. A TV title due
 * in both queues takes one full refresh (providers ride along); otherwise the
 * oldest cache wins. This avoids fixed quota splits that can starve either
 * queue as a large library converges over successive nights.
 */
async function selectCandidates(
  userId: string,
  region: string,
  limit: number,
): Promise<SyncCandidate[]> {
  const [metadata, providers] = await Promise.all([
    selectMetadataCandidates(userId, limit),
    selectProviderCandidates(userId, region, limit),
  ]);
  const byTitle = new Map<string, SyncCandidate>();

  for (const candidate of providers) byTitle.set(candidate.id, candidate);
  for (const candidate of metadata) {
    const providerCandidate = byTitle.get(candidate.id);
    byTitle.set(candidate.id, {
      ...candidate,
      dueAt: Math.min(candidate.dueAt, providerCandidate?.dueAt ?? candidate.dueAt),
    });
  }

  return [...byTitle.values()]
    .sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id))
    .slice(0, limit);
}

// --- Pure helpers -----------------------------------------------------------

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value.length <= 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return a.getTime() === b.getTime();
}

/** The Season fields available without loading its episode list. */
export interface StoredSeasonSummary {
  seasonNumber: number;
  episodeCount: number | null;
  airDate: Date | null;
}

/**
 * Which full season endpoints a TV refresh needs to read.
 *
 * TMDB's TV-detail response already carries season number, episode count and
 * air date. Historical seasons whose compact summary still matches the local
 * row cannot contain a newly numbered episode, so loading every episode in
 * every season again is wasted work. Changed/missing seasons are refreshed,
 * plus the newest two regardless of summary equality: those are where TMDB
 * commonly backfills names, runtimes and episode metadata without changing the
 * compact counters.
 */
export function seasonNumbersToRefresh(
  remote: ReadonlyArray<Omit<TmdbSeasonSummary, "id">>,
  stored: ReadonlyArray<StoredSeasonSummary>,
  newestCount = 2,
): number[] {
  const summaries = new Map(
    remote
      .filter((season) => Number.isInteger(season.season_number) && season.season_number >= 1)
      .map((season) => [season.season_number, season] as const),
  );
  const local = new Map(stored.map((season) => [season.seasonNumber, season]));
  const ordered = [...summaries.keys()].sort((a, b) => a - b);
  const selected = new Set(ordered.slice(-Math.max(0, Math.trunc(newestCount))));

  for (const seasonNumber of ordered) {
    const summary = summaries.get(seasonNumber)!;
    const current = local.get(seasonNumber);
    if (!current) {
      selected.add(seasonNumber);
      continue;
    }
    const episodeCountChanged =
      summary.episode_count !== undefined &&
      current.episodeCount !== summary.episode_count;
    const airDateChanged =
      summary.air_date !== undefined &&
      !sameDate(current.airDate, toDate(summary.air_date));
    if (episodeCountChanged || airDateChanged) selected.add(seasonNumber);
  }

  return [...selected].sort((a, b) => a - b);
}

/**
 * Title-level metadata to refresh from a TMDB detail response.
 *
 * A refresh only ever replaces a stored value with a real one. An empty
 * overview (a missing en-US translation), an empty genre list, a missing image
 * or date, a 0 rating (no votes yet) and a 0 runtime all mean TMDB doesn't
 * know, and blanking what the title page already shows would be a regression.
 * TV runtime comes from `episode_run_time`, which is empty for most current
 * shows, so it is written only when TMDB actually states one. The name is left
 * alone: legacy import rows may carry the owner's own spelling.
 */
export function titleMetadataFromDetail(
  detail: TmdbTitleSyncDetail,
  mediaType: MediaType,
): Prisma.TitleUpdateManyMutationInput {
  const isTv = mediaType === MediaType.TV;
  const releaseDate = toDate(isTv ? detail.first_air_date : detail.release_date);
  const runtime = isTv ? detail.episode_run_time?.[0] : detail.runtime;
  const genres = (detail.genres ?? []).map((g) => g.name);
  return {
    ...(detail.poster_path ? { posterPath: detail.poster_path } : {}),
    ...(detail.backdrop_path ? { backdropPath: detail.backdrop_path } : {}),
    ...(detail.overview ? { overview: detail.overview } : {}),
    ...(detail.vote_average ? { tmdbRating: detail.vote_average } : {}),
    ...(genres.length > 0 ? { genres } : {}),
    ...(releaseDate ? { releaseDate } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

/**
 * TMDB provider ids the owner could stream this on in their region.
 *
 * Subscription, free and ad-supported are all "included with something you
 * already have", which is the question these ids answer; rent and buy are not.
 * That matches how regionWatchInfo groups them for display, but the display
 * cap is deliberately not applied — a provider trimmed for being the ninth most
 * prominent could still be the one the owner actually subscribes to.
 */
export function streamProviderIdsForRegion(
  results: Record<string, TmdbRegionProviders> | undefined,
  region: string,
): number[] {
  const r = results?.[region];
  if (!r) return [];
  const ids = new Set<number>();
  for (const list of [r.flatrate, r.free, r.ads]) {
    for (const p of list ?? []) ids.add(p.provider_id);
  }
  return [...ids].sort((a, b) => a - b);
}

/** The write used to rotate a provider-only failure without relabelling stale ids. */
export function providerFailureUpdate(
  region: string,
  previousRegion: string | null | undefined,
  attemptedAt: Date,
): {
  providersSyncedAt: Date;
  providersRegion: string;
  streamProviderIds?: number[];
} {
  return {
    providersSyncedAt: attemptedAt,
    providersRegion: region,
    ...(previousRegion !== region ? { streamProviderIds: [] } : {}),
  };
}

/** Metadata a Season row mirrors from TMDB — everything else is ours. */
interface SeasonFields {
  tmdbId: number | null;
  name: string | null;
  overview: string | null;
  airDate: Date | null;
  posterPath: string | null;
  episodeCount: number | null;
}

/** Metadata an Episode row mirrors from TMDB. Never watched/watchedAt/discoveredAt. */
interface EpisodeFields {
  tmdbId: number | null;
  name: string | null;
  overview: string | null;
  airDate: Date | null;
  runtime: number | null;
  stillPath: string | null;
}

function seasonFieldsFromTmdb(sd: TmdbSeasonDetails): SeasonFields {
  return {
    tmdbId: sd.id,
    name: sd.name || null,
    overview: sd.overview || null,
    airDate: toDate(sd.air_date),
    posterPath: sd.poster_path,
    episodeCount: sd.episodes?.length ?? null,
  };
}

function episodeFieldsFromTmdb(ep: TmdbEpisode): EpisodeFields {
  return {
    tmdbId: ep.id,
    name: ep.name || null,
    overview: ep.overview || null,
    airDate: toDate(ep.air_date),
    runtime: ep.runtime ?? null,
    stillPath: ep.still_path,
  };
}

function seasonUnchanged(current: SeasonFields, next: SeasonFields): boolean {
  return (
    current.tmdbId === next.tmdbId &&
    current.name === next.name &&
    current.overview === next.overview &&
    sameDate(current.airDate, next.airDate) &&
    current.posterPath === next.posterPath &&
    current.episodeCount === next.episodeCount
  );
}

function episodeUnchanged(current: EpisodeFields, next: EpisodeFields): boolean {
  return (
    current.tmdbId === next.tmdbId &&
    current.name === next.name &&
    current.overview === next.overview &&
    sameDate(current.airDate, next.airDate) &&
    current.runtime === next.runtime &&
    current.stillPath === next.stillPath
  );
}

// --- One title --------------------------------------------------------------

export interface TitleSyncOutcome {
  titleId: string;
  name: string;
  /** OK / PARTIAL / FAILED as recorded on the title; VANISHED if it went away mid-run. */
  state: MetadataSyncState | "VANISHED";
  /** Episode rows this run materialized for the first time. */
  newEpisodes: number;
  error?: string;
}

/** Longest a single title's write transaction may run. Matches lib/actions. */
const TITLE_TX_TIMEOUT_MS = 20000;

/** How much of a TMDB error message is worth keeping on the title row. */
const MAX_ERROR_LENGTH = 500;

function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, MAX_ERROR_LENGTH);
}

async function recordFailure(
  userId: string,
  candidate: SyncCandidate,
  message: string,
  now: Date,
  keepPlace = false,
): Promise<boolean> {
  // A failed old request must not mark a newly rematched title FAILED. The same
  // identity boundary guards both successful writes and their failure stamps.
  const updated = await prisma.title.updateMany({
    where: {
      id: candidate.id,
      userId,
      deletedAt: null,
      tmdbId: candidate.tmdbId,
      mediaType: candidate.mediaType,
    },
    data: {
      // Stamped even on failure: the queue is ordered by this column, so
      // leaving it untouched would park a permanently broken title at the head
      // of every future run and starve everything behind it. The FAILED state
      // and the message below are what make the failure visible instead. The
      // one exception is `keepPlace`: a first transient failure, which the
      // next run should retry first rather than days later.
      ...(keepPlace ? {} : { metadataSyncedAt: now }),
      metadataSyncState: MetadataSyncState.FAILED,
      metadataLastError: message,
    },
  });
  return updated.count > 0;
}

/**
 * Move a failed provider-only attempt to the back of its rotation.
 *
 * Merely stamping providersSyncedAt is not enough after a region change: the
 * wrong-region queue deliberately outranks every dated row. Record the region
 * that was attempted as well, clearing ids only when they belong to a different
 * region so stale GB ids cannot be presented as a failed US lookup. A failure
 * in the same region preserves the last known provider list.
 */
async function recordProviderFailure(
  userId: string,
  region: string,
  candidate: SyncCandidate,
  now: Date,
  removed: boolean,
): Promise<boolean> {
  const updated = await prisma.title.updateMany({
    where: {
      id: candidate.id,
      userId,
      deletedAt: null,
      tmdbId: candidate.tmdbId,
      mediaType: candidate.mediaType,
    },
    data: {
      ...providerFailureUpdate(region, candidate.providersRegion, now),
      // This path is the only refresh movies get, so a title TMDB has removed
      // is recorded where Settings lists failures; otherwise nothing would
      // ever tell the owner it needs a new match.
      ...(removed
        ? {
            metadataSyncState: MetadataSyncState.FAILED,
            metadataLastError: REMOVED_FROM_TMDB_MESSAGE,
          }
        : {}),
    },
  });
  return updated.count > 0;
}

async function syncOneTitle(
  userId: string,
  region: string,
  candidate: SyncCandidate,
  now: Date,
  deadline: number,
): Promise<TitleSyncOutcome> {
  const detail = await fetchTvDetail(candidate.tmdbId, deadline);

  // Season 0 is specials; lib/actions excludes it on add and re-match, so the
  // sync must too or every show would grow a season it never had.
  const seasonNumbers = seasonNumbersToRefresh(
    detail.seasons ?? [],
    candidate.seasons,
  );

  // Up to 20 seasons per request; the ids appended seasons lack come from the
  // show's own season list. A request that fails counts as its seasons
  // failing to load.
  const summaries = new Map(
    (detail.seasons ?? []).map((season) => [season.season_number, season]),
  );
  const fetched = await mapLimit(
    chunks(
      seasonNumbers.map((n) => summaries.get(n)!),
      MAX_APPENDED_SEASONS,
    ),
    SEASON_CONCURRENCY,
    (chunk) =>
      fetchSeasons(candidate.tmdbId, chunk, deadline).catch((err: unknown) => {
        // Running out of budget is not a season that failed to load. Treating it
        // as one would write PARTIAL and stamp metadataSyncedAt, sending a title
        // to the back of the queue with half its seasons read; abandoning the
        // whole title leaves it where it is, first in line tomorrow. A rejected
        // token is the whole run's failure, not this season's.
        if (err instanceof SyncBudgetExhaustedError || isAuthFailure(err)) throw err;
        return [];
      }),
  );
  const seasons = fetched.flat();
  const allOk = seasons.length === seasonNumbers.length;

  const nextEpisodeAirDate = deriveNextEpisodeAirDate(
    detail.next_episode_to_air?.air_date,
    seasons,
    now,
  );
  // An absent append means the request didn't carry provider data at all, which
  // is not the same as "not streamable here" — leave the cached ids alone
  // rather than blanking them on a partial response.
  const providers = detail["watch/providers"];

  const result = await prisma.$transaction(
    async (tx) => {
      // Title row lock FIRST, matching every transaction in lib/actions: the
      // Season/Episode writes below would otherwise take their locks in the
      // opposite order from a concurrent recomputeProgress or re-match and
      // could deadlock against it. The userId in the predicate makes the lock
      // double as the ownership check.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Title"
        WHERE id = ${candidate.id}
          AND "userId" = ${userId}
          AND "deletedAt" IS NULL
          AND "tmdbId" = ${candidate.tmdbId}
          AND "mediaType" = ${candidate.mediaType}::"MediaType"
        FOR UPDATE`;
      if (!locked[0]) return null; // deleted, trashed, or rematched concurrently

      const newEpisodes = await upsertSeasons(tx, candidate, seasons, now);

      // Recount from the rows that exist rather than trusting TMDB's
      // number_of_episodes: a partial season load, or an episode TMDB dropped,
      // would otherwise leave the progress bar quoting a total nothing backs.
      const totalEpisodes = await tx.episode.count({
        where: { season: { titleId: candidate.id }, ...ACTIVE_EPISODE_FILTER },
      });
      const watchedEpisodes = await tx.episode.count({
        where: {
          season: { titleId: candidate.id },
          watched: true,
          ...ACTIVE_EPISODE_FILTER,
        },
      });

      await tx.title.update({
        where: { id: candidate.id },
        data: {
          ...titleMetadataFromDetail(detail, MediaType.TV),
          tmdbStatus: detail.status ?? null,
          nextEpisodeAirDate,
          // Only written when TMDB actually stated it: a response that omits
          // the field is missing data, and blanking a season count the title
          // page already displays would be a visible regression for no reason.
          ...(typeof detail.number_of_seasons === "number"
            ? { totalSeasons: detail.number_of_seasons }
            : {}),
          totalEpisodes,
          watchedEpisodes,
          metadataSyncedAt: now,
          metadataSyncState: allOk ? MetadataSyncState.OK : MetadataSyncState.PARTIAL,
          metadataLastError: allOk
            ? null
            : `${seasonNumbers.length - seasons.length} of ${seasonNumbers.length} changed or recent seasons could not be loaded from TMDB.`,
          // WatchStatus is deliberately untouched. A new season arriving does
          // not un-watch a show the owner finished — the "New episodes" badge
          // is how that gets surfaced, and flipping the status here would
          // silently overwrite a choice they made by hand.
          // Provider ids are cached here for the library's "On my services"
          // filter, which reads them against User.myProviders. Cheap to keep
          // — it rides along on a request the sync makes anyway.
          ...(providers
            ? {
                streamProviderIds: streamProviderIdsForRegion(providers.results, region),
                providersRegion: region,
                providersSyncedAt: now,
              }
            : {}),
        },
      });

      return { newEpisodes };
    },
    { timeout: TITLE_TX_TIMEOUT_MS },
  );

  if (result === null) {
    return { titleId: candidate.id, name: candidate.name, state: "VANISHED", newEpisodes: 0 };
  }
  return {
    titleId: candidate.id,
    name: candidate.name,
    state: allOk ? MetadataSyncState.OK : MetadataSyncState.PARTIAL,
    newEpisodes: result.newEpisodes,
  };
}

/**
 * Refresh the included/free/ad-supported provider ids for one title, plus the
 * title-level metadata that rides along on the same request.
 */
async function syncProviderOnly(
  userId: string,
  region: string,
  candidate: SyncCandidate,
  now: Date,
  deadline: number,
): Promise<TitleSyncOutcome> {
  const detail = await fetchDetailWithProviders(
    candidate.mediaType,
    candidate.tmdbId,
    deadline,
  );
  const providers = detail["watch/providers"];
  // A valid empty regional result is represented by a populated results map
  // without the requested region. A missing map means the response itself was
  // incomplete, so preserve the last known cache and retry on a later run.
  if (!providers?.results) throw new Error("TMDB provider response omitted results.");
  const updated = await prisma.title.updateMany({
    where: {
      id: candidate.id,
      userId,
      deletedAt: null,
      tmdbId: candidate.tmdbId,
      mediaType: candidate.mediaType,
    },
    data: {
      ...titleMetadataFromDetail(detail, candidate.mediaType),
      // Finished, watched shows only ever come through here, so this is where
      // a revival ("Ended" back to "Returning Series") is noticed: the new
      // status puts the show back in the metadata queue. The next air date is
      // left alone, because without season data this path could only clear a
      // date the metadata path derived.
      ...(candidate.mediaType === MediaType.TV && detail.status
        ? { tmdbStatus: detail.status }
        : {}),
      streamProviderIds: streamProviderIdsForRegion(providers.results, region),
      providersRegion: region,
      providersSyncedAt: now,
      // No other sync path writes a movie's sync state, so a success here
      // clears a removal recorded above once TMDB lists the title again.
      ...(candidate.mediaType === MediaType.MOVIE
        ? { metadataSyncState: null, metadataLastError: null }
        : {}),
    },
  });

  return {
    titleId: candidate.id,
    name: candidate.name,
    state: updated.count === 0 ? "VANISHED" : MetadataSyncState.OK,
    newEpisodes: 0,
  };
}

/**
 * Upserts seasons and their episodes by number, returning how many episode rows
 * were created. Existing rows keep their identity — and with it `discoveredAt`,
 * `watched` and `watchedAt` — and are written back only when a TMDB field they
 * mirror actually differs, so a run that finds nothing new performs no writes.
 * Created rows get their `discoveredAt` from discoveredAtForNewEpisode rather
 * than the schema default, so materializing a back catalogue does not read as a
 * night of new episodes.
 */
async function upsertSeasons(
  tx: Prisma.TransactionClient,
  title: SyncCandidate,
  seasons: TmdbSeasonDetails[],
  now: Date,
): Promise<number> {
  const titleId = title.id;
  const existing = await tx.season.findMany({
    where: { titleId },
    select: {
      id: true,
      seasonNumber: true,
      tmdbId: true,
      name: true,
      overview: true,
      airDate: true,
      posterPath: true,
      episodeCount: true,
      episodes: {
        select: {
          id: true,
          episodeNumber: true,
          tmdbId: true,
          name: true,
          overview: true,
          airDate: true,
          runtime: true,
          stillPath: true,
          watched: true,
          withdrawnAt: true,
        },
      },
    },
  });
  const bySeasonNumber = new Map(existing.map((s) => [s.seasonNumber, s]));

  let created = 0;
  for (const sd of seasons) {
    const fields = seasonFieldsFromTmdb(sd);
    const episodes = sd.episodes ?? [];
    const current = bySeasonNumber.get(sd.season_number);

    if (!current) {
      const season = await tx.season.create({
        data: { titleId, seasonNumber: sd.season_number, ...fields },
      });
      if (episodes.length > 0) {
        await tx.episode.createMany({
          data: episodes.map((ep) => {
            const fresh = episodeFieldsFromTmdb(ep);
            return {
              seasonId: season.id,
              episodeNumber: ep.episode_number,
              ...fresh,
              withdrawnAt: null,
              // A season missing locally is as often one that was never
              // materialized as it is a season that just aired, so each episode
              // is dated on its own evidence.
              discoveredAt: discoveredAtForNewEpisode(fresh.airDate, title.createdAt, now),
            };
          }),
        });
        created += episodes.length;
      }
      continue;
    }

    if (!seasonUnchanged(current, fields)) {
      await tx.season.update({ where: { id: current.id }, data: fields });
    }

    const byTmdbId = new Map(
      current.episodes.flatMap((episode) =>
        episode.tmdbId === null ? [] : [[episode.tmdbId, episode] as const],
      ),
    );
    const legacyByEpisodeNumber = new Map(
      current.episodes
        .filter((episode) => episode.tmdbId === null && episode.withdrawnAt === null)
        .map((episode) => [episode.episodeNumber, episode] as const),
    );
    const planned = episodes.map((episode) => ({
      episode,
      fresh: episodeFieldsFromTmdb(episode),
      row:
        byTmdbId.get(episode.id) ??
        legacyByEpisodeNumber.get(episode.episode_number),
    }));
    const matchedIds = new Set(
      planned.flatMap(({ row }) => (row ? [row.id] : [])),
    );

    // Free coordinates TMDB no longer owns before applying renumberings. A
    // watched row is never destroyed: stamp it withdrawn while preserving its
    // number and air date. If a different active episode now needs that number,
    // move the withdrawn row into a reserved range before the renumber phase.
    // If TMDB later restores the same id, the id-first plan revives this row.
    const activeCoordinates = new Set(episodes.map((episode) => episode.episode_number));
    for (const row of current.episodes) {
      if (matchedIds.has(row.id)) continue;
      if (!row.watched) {
        await tx.episode.delete({ where: { id: row.id } });
      } else {
        const coordinateIsReused = activeCoordinates.has(row.episodeNumber);
        if (row.withdrawnAt !== null && !coordinateIsReused) continue;
        await tx.episode.update({
          where: { id: row.id },
          data: {
            ...(coordinateIsReused
              ? {
                  episodeNumber:
                    row.episodeNumber + WITHDRAWN_EPISODE_NUMBER_OFFSET,
                }
              : {}),
            withdrawnAt: row.withdrawnAt ?? now,
          },
        });
      }
    }

    // Coordinate swaps (E1 -> E2 while E2 -> E3, for example) cannot be
    // written directly under the season/number unique. Park every moving row
    // on its own large positive coordinate first, then write final TMDB
    // numbers. Adding the same offset preserves uniqueness and satisfies the
    // database's non-negative episode-number CHECK.
    for (const { episode, row } of planned) {
      if (row && row.episodeNumber !== episode.episode_number) {
        await tx.episode.update({
          where: { id: row.id },
          data: { episodeNumber: row.episodeNumber + EPISODE_RENUMBER_OFFSET },
        });
      }
    }

    const toCreate: Prisma.EpisodeCreateManyInput[] = [];
    for (const { episode, fresh, row } of planned) {
      if (!row) {
        toCreate.push({
          seasonId: current.id,
          episodeNumber: episode.episode_number,
          ...fresh,
          withdrawnAt: null,
          // An episode appearing inside a season we already hold is usually the
          // "this just showed up" case the badge exists for — but the same gap
          // opens when an old episode was never stored, so it is judged by its
          // air date like any other created row.
          discoveredAt: discoveredAtForNewEpisode(fresh.airDate, title.createdAt, now),
        });
        continue;
      }
      if (
        row.episodeNumber !== episode.episode_number ||
        row.withdrawnAt !== null ||
        !episodeUnchanged(row, fresh)
      ) {
        await tx.episode.update({
          where: { id: row.id },
          data: { episodeNumber: episode.episode_number, ...fresh, withdrawnAt: null },
        });
      }
    }
    if (toCreate.length > 0) {
      await tx.episode.createMany({ data: toCreate });
      created += toCreate.length;
    }
  }

  return created;
}

// --- Run --------------------------------------------------------------------

export interface SyncRunOptions {
  /** Titles per user per run. Clamped to 1..200. */
  limit?: number;
  /**
   * Epoch milliseconds after which no further title is STARTED, and after which
   * a title already in flight makes no further TMDB request. Both halves
   * matter: gating only the start let one 400-episode show begin just under the
   * deadline and then fetch season after season well past the function's
   * duration limit, which is exactly the mid-run kill the deadline exists to
   * avoid. Whatever the run drops keeps its place at the head of the queue and
   * goes first next time.
   */
  deadline?: number;
  /** Titles refreshed at once. Clamped to 1..8. */
  concurrency?: number;
}

export interface SyncRunResult {
  userId: string;
  /** Candidates picked for this run. */
  considered: number;
  /** Titles that finished with OK or PARTIAL. */
  synced: number;
  /** Titles whose refresh failed after being selected. */
  failed: number;
  /** Titles not completed because the budget expired or the row vanished mid-run. */
  skipped: number;
  /** Episode rows materialized for the first time across the whole run. */
  newEpisodes: number;
  /** Account-level failure before title outcomes existed; counters remain title-only. */
  runError?: string;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/**
 * Reduce title outcomes into the public run counters.
 *
 * VANISHED is skipped rather than silently disappearing from the totals: a
 * concurrently deleted title was considered but no longer exists to sync.
 * Keeping this pure makes the invariant explicit and regression-testable.
 */
export function tallySyncOutcomes(
  userId: string,
  considered: number,
  outcomes: ReadonlyArray<TitleSyncOutcome | null>,
): SyncRunResult {
  const result: SyncRunResult = {
    userId,
    considered,
    synced: 0,
    failed: 0,
    skipped: 0,
    newEpisodes: 0,
  };
  for (const outcome of outcomes) {
    if (outcome === null || outcome.state === "VANISHED") {
      result.skipped++;
      continue;
    }
    if (outcome.state === MetadataSyncState.FAILED) result.failed++;
    else result.synced++;
    result.newEpisodes += outcome.newEpisodes;
  }
  return result;
}

/** Refresh one owner's TV metadata and watchlist provider cache. Idempotent. */
export async function syncUserMetadata(
  userId: string,
  options: SyncRunOptions = {},
): Promise<SyncRunResult> {
  const limit = clamp(options.limit, DEFAULT_SYNC_LIMIT, 1, 200);
  const concurrency = clamp(options.concurrency, DEFAULT_CONCURRENCY, 1, 8);
  const deadline = options.deadline ?? Number.POSITIVE_INFINITY;

  const owner = await prisma.user.findUnique({
    where: { id: userId },
    select: { watchRegion: true },
  });
  // The title page lets a device override the region with a cookie; a cron has
  // no device, so the account preference is the only sensible source here.
  const region = isWatchRegion(owner?.watchRegion)
    ? owner.watchRegion
    : DEFAULT_WATCH_REGION;

  const candidates = await selectCandidates(userId, region, limit);
  const now = new Date();
  let authFailure: unknown = null;

  const outcomes = await mapLimit<SyncCandidate, TitleSyncOutcome | null>(
    candidates,
    concurrency,
    async (candidate) => {
      if (authFailure !== null || Date.now() >= deadline) return null;
      try {
        return candidate.kind === "TV_METADATA"
          ? await syncOneTitle(userId, region, candidate, now, deadline)
          : await syncProviderOnly(userId, region, candidate, now, deadline);
      } catch (err) {
        // A title abandoned because the budget ran out is skipped, not failed:
        // nothing is wrong with it, and recording FAILED would both stamp
        // metadataSyncedAt — losing its place at the head of the queue — and
        // report a problem the owner cannot act on.
        if (err instanceof SyncBudgetExhaustedError) return null;
        // A rejected token fails every title the same way. Stamping each one
        // FAILED would bury the single real cause under a list of identical
        // rows and send the whole batch to the back of the queue, so the run
        // stops starting titles and reports it once, below.
        if (isAuthFailure(err)) {
          authFailure ??= err;
          return null;
        }
        const removed = err instanceof TmdbError && err.status === 404;
        const message = removed ? REMOVED_FROM_TMDB_MESSAGE : errorMessage(err);
        console.error(
          `metadata sync failed (titleId=${candidate.id}, tmdbId=${candidate.tmdbId}, kind=${candidate.kind}):`,
          err,
        );
        let identityStillCurrent = true;
        if (candidate.kind === "TV_METADATA") {
          // A 429 or 5xx that outlasted its retry is TMDB having a bad moment,
          // so the first one keeps the title's place and the next run tries it
          // first, with the failure still recorded where Settings shows it. A
          // title that had already failed is stamped as usual, so a title TMDB
          // keeps rejecting can't hold the head of the queue night after night.
          const keepPlace =
            err instanceof TmdbError &&
            isTransientStatus(err.status) &&
            candidate.metadataSyncState !== MetadataSyncState.FAILED;
          // Recording the failure must not itself abort the run — if the database
          // is the thing that is unwell, the next title will report it too.
          identityStillCurrent = await recordFailure(
            userId,
            candidate,
            message,
            new Date(),
            keepPlace,
          ).catch((writeErr) => {
            console.error(
              `metadata sync could not record failure (titleId=${candidate.id}):`,
              writeErr,
            );
            return true;
          });
        } else {
          // Provider failures still need an attempt stamp or one broken lookup
          // pins the provider queue forever and starves every title behind it.
          // Unlike the metadata path, a transient failure is stamped too: this
          // path has no failure state to show a waiting title by, so keeping
          // its place would hide it at the head of the queue. Only a removal
          // is recorded.
          identityStillCurrent = await recordProviderFailure(
            userId,
            region,
            candidate,
            new Date(),
            removed,
          ).catch((writeErr) => {
            console.error(
              `metadata sync could not record provider failure (titleId=${candidate.id}):`,
              writeErr,
            );
            return true;
          });
        }
        if (!identityStillCurrent) {
          return {
            titleId: candidate.id,
            name: candidate.name,
            state: "VANISHED",
            newEpisodes: 0,
          };
        }
        return {
          titleId: candidate.id,
          name: candidate.name,
          state: MetadataSyncState.FAILED,
          newEpisodes: 0,
          error: message,
        };
      }
    },
  );

  // Rethrown only once the titles already in flight have settled, so nothing
  // is still writing when runScheduledSync records it as this account's
  // runError.
  if (authFailure !== null) throw authFailure;

  return tallySyncOutcomes(userId, candidates.length, outcomes);
}

export interface ScheduledSyncResult {
  startedAt: string;
  durationMs: number;
  users: SyncRunResult[];
}

/**
 * Health verdict for one scheduled run (AUD-OPS-04). An account counts as
 * failed when it died before title work began (runError) or when every title
 * it selected failed; an account with nothing to consider is healthy, not
 * vacuously failed. `totalFailure` means every account failed — the cron
 * route maps it to a non-2xx status because Vercel's cron dashboard
 * distinguishes runs by status code alone. `degraded` flags any failure at
 * all, so log searches have one field to match.
 */
export function summarizeScheduledRun(result: ScheduledSyncResult): {
  totalFailure: boolean;
  degraded: boolean;
} {
  const failedUser = (u: SyncRunResult) =>
    u.runError !== undefined || (u.considered > 0 && u.synced === 0 && u.failed > 0);
  const totalFailure = result.users.length > 0 && result.users.every(failedUser);
  const degraded = result.users.some((u) => failedUser(u) || u.failed > 0);
  return { totalFailure, degraded };
}

/**
 * Refresh every account's TV metadata. Celluloid is single-owner in practice,
 * but the schema is per-user and a cron has no session to scope itself with, so
 * users are resolved directly and each run is scoped to one userId — the same
 * rule every other read in the app follows.
 */
export async function runScheduledSync(
  options: SyncRunOptions = {},
): Promise<ScheduledSyncResult> {
  const startedAt = new Date();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const results: SyncRunResult[] = [];
  for (const [index, user] of users.entries()) {
    // Sequential across accounts: the budget is wall clock, so running two
    // libraries at once buys none of it back and only risks blowing past the
    // function's duration limit together.
    //
    // Each account gets an equal share of what is LEFT when its turn comes,
    // rather than every account sharing one absolute deadline. Under the shared
    // deadline the first account could spend the lot and each account after it
    // got progressively less, with the last reliably getting none. Recomputing
    // the share from the clock each time also hands an early finisher's unused
    // time to the accounts behind it. With one owner — which is what Celluloid
    // is — this is arithmetically the old behaviour, the whole budget for the
    // only account, so a real scheduler would be machinery for a case that does
    // not exist.
    const deadline =
      options.deadline === undefined
        ? undefined
        : Date.now() +
          Math.round(Math.max(0, options.deadline - Date.now()) / (users.length - index));
    try {
      results.push(await syncUserMetadata(user.id, { ...options, deadline }));
    } catch (err) {
      // Candidate selection and owner lookup happen outside the title-level
      // recovery loop. Keep their failure scoped to this account so one broken
      // library cannot prevent later owners from receiving their turn.
      const message = errorMessage(err);
      console.error(`metadata sync failed (userId=${user.id}):`, err);
      results.push({
        userId: user.id,
        considered: 0,
        synced: 0,
        failed: 0,
        skipped: 0,
        newEpisodes: 0,
        runError: message,
      });
    }
  }

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    users: results,
  };
}
