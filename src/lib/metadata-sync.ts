import "server-only";
import { prisma } from "@/lib/prisma";
import {
  MediaType,
  MetadataSyncState,
  WatchStatus,
  type Prisma,
} from "@/generated/prisma/client";
import type { TmdbEpisode, TmdbRegionProviders, TmdbSeasonDetails } from "@/lib/tmdb";
import { DEFAULT_WATCH_REGION, isWatchRegion } from "@/lib/tmdb-extras";
import { mapLimit } from "@/lib/async";

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
 *   - Episodes are UPSERTED by (seasonNumber, episodeNumber), never deleted and
 *     recreated. rematchTitle's delete-and-recreate is correct for a re-link
 *     (it carries `discoveredAt` forward explicitly), but doing it on every
 *     nightly run would rewrite every row and hand each one a fresh
 *     `discoveredAt` — badging the entire library as "new" and destroying the
 *     exact signal this sync produces.
 *   - A row this run does create is dated by its own air date rather than by
 *     the run, so materializing a back catalogue is not mistaken for a night of
 *     new episodes. See discoveredAtForNewEpisode.
 *   - Rows are never removed. TMDB occasionally drops or renumbers an episode
 *     for a day; deleting on that basis would take the owner's watched flag
 *     with it. The denormalized counters are recomputed from the rows that
 *     actually exist, so a stale extra row is visible in the count rather than
 *     silently papered over.
 *   - One title's failure is recorded on that title and the run continues.
 */

// --- TMDB access ------------------------------------------------------------
//
// This module does its own fetching rather than calling lib/tmdb's getTv /
// getSeason. Those wrappers cache responses for 24h, which is right for the
// interactive paths but wrong here: on a daily cadence a still-warm entry means
// the sync reads yesterday's answer to "did anything air?" — the one question
// it exists to ask. lib/tmdb's fetcher is module-private and its caching is
// baked into each endpoint wrapper, so there is no way to opt out from outside
// it. Response TYPES are still imported from there, so the shapes stay in one
// place.

const TMDB_BASE = "https://api.themoviedb.org/3";

/** Bound one attempt so a stalled TMDB response can't eat the run's budget. */
const TMDB_TIMEOUT_MS = 8000;

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

/** The fields the sync reads off /tv/{id}; a superset of TmdbTvDetails. */
interface TmdbTvSyncDetail {
  id: number;
  name?: string;
  number_of_seasons?: number | null;
  /** TMDB's lifecycle string: "Returning Series", "Ended", "Canceled", ... */
  status?: string | null;
  next_episode_to_air?: { air_date?: string | null } | null;
  seasons?: { season_number: number }[];
  "watch/providers"?: { results?: Record<string, TmdbRegionProviders> };
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
  const token = process.env.TMDB_ACCESS_TOKEN;
  if (!token) throw new Error("TMDB_ACCESS_TOKEN is not set.");
  const url = new URL(TMDB_BASE + path);
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
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Math.min(retryAfter > 0 ? retryAfter * 1000 : 800, 3000);
      // Only sleep on a retry the budget can actually pay for; otherwise fall
      // through and report the TMDB status, which is the real failure.
      if (Date.now() + wait < deadline) {
        await sleep(wait);
        continue;
      }
    }
    throw new Error(`TMDB ${res.status} on ${path}`);
  }
}

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

function fetchSeason(
  tmdbId: number,
  seasonNumber: number,
  deadline: number,
): Promise<TmdbSeasonDetails> {
  return tmdbGet<TmdbSeasonDetails>(
    `/tv/${tmdbId}/season/${seasonNumber}`,
    { language: "en-US" },
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
  /** Immutable, and the date back-catalogue episodes are dated to. See upsertSeasons. */
  createdAt: Date;
}

/** Everything the candidate query needs beyond the sync-state split below. */
function candidateWhere(userId: string): Prisma.TitleWhereInput {
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

const CANDIDATE_SELECT = {
  id: true,
  tmdbId: true,
  name: true,
  createdAt: true,
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
async function selectCandidates(userId: string, limit: number): Promise<SyncCandidate[]> {
  const where = candidateWhere(userId);

  const neverSynced = await prisma.title.findMany({
    where: { ...where, metadataSyncedAt: null },
    orderBy: { id: "asc" },
    take: limit,
    select: CANDIDATE_SELECT,
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
            select: CANDIDATE_SELECT,
          })),
        ];

  // tmdbId is non-null by the filter above; the narrowing keeps that provable.
  return rows.flatMap((r) =>
    r.tmdbId === null
      ? []
      : [{ id: r.id, tmdbId: r.tmdbId, name: r.name, createdAt: r.createdAt }],
  );
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

/**
 * When the next episode airs, or null once nothing is scheduled.
 *
 * TMDB's own `next_episode_to_air` is authoritative but frequently absent for
 * smaller and regional shows, so the earliest future air date across the
 * seasons we just read stands in for it. Returning null when neither knows is
 * deliberate: it clears a date that has since passed, so the airing-soon view
 * never advertises an episode that already aired.
 */
export function deriveNextEpisodeAirDate(
  tmdbNextAirDate: string | null | undefined,
  seasons: TmdbSeasonDetails[],
  now: Date,
): Date | null {
  const today = startOfUtcDay(now).getTime();
  const stated = toDate(tmdbNextAirDate);
  if (stated && stated.getTime() >= today) return stated;

  let earliest: Date | null = null;
  for (const season of seasons) {
    for (const ep of season.episodes ?? []) {
      const airs = toDate(ep.air_date);
      if (!airs || airs.getTime() < today) continue;
      if (earliest === null || airs.getTime() < earliest.getTime()) earliest = airs;
    }
  }
  return earliest;
}

/** Air dates are calendar dates, so "future" is measured from midnight, not now. */
function startOfUtcDay(now: Date): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
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

/** How recently an episode must have aired to still count as a discovery. */
const RECENT_AIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What `discoveredAt` a row this run creates should carry.
 *
 * Every created row used to take the schema's now() default. That is right for
 * an episode that genuinely just appeared, but wrong for back catalogue: a show
 * whose older seasons were never materialized — a partial add, or a season
 * whose fetch failed on the day it was added — would have sixty episodes appear
 * on a single night, all stamped as discovered now, and the owner would get a
 * "New" badge for a season from 2015. discoveredAt means "TMDB gained this
 * since you last looked", so only an episode that plausibly IS new earns the
 * sync's timestamp; anything older is dated to the title itself, the same
 * answer lib/backup gives an episode recovered from a backup.
 */
export function discoveredAtForNewEpisode(
  airDate: Date | null,
  titleCreatedAt: Date,
  now: Date,
): Date {
  // No air date at all is TMDB announcing an episode it has not scheduled yet,
  // which is forward-looking rather than back catalogue. (The badge also
  // requires an air date already past, so such a row cannot fire it either way.)
  if (airDate === null) return now;
  return airDate.getTime() >= now.getTime() - RECENT_AIR_WINDOW_MS ? now : titleCreatedAt;
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
  titleId: string,
  message: string,
  now: Date,
): Promise<void> {
  // updateMany, scoped by userId, so a title that was deleted or reassigned
  // between the read and here is a no-op rather than a thrown P2025 that would
  // mask the real error being recorded.
  await prisma.title.updateMany({
    where: { id: titleId, userId },
    data: {
      // Stamped even on failure: the queue is ordered by this column, so
      // leaving it untouched would park a permanently broken title at the head
      // of every future run and starve everything behind it. The FAILED state
      // and the message below are what make the failure visible instead.
      metadataSyncedAt: now,
      metadataSyncState: MetadataSyncState.FAILED,
      metadataLastError: message,
    },
  });
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
  const seasonNumbers = (detail.seasons ?? [])
    .map((s) => s.season_number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);

  const fetched = await mapLimit(seasonNumbers, SEASON_CONCURRENCY, (n) =>
    fetchSeason(candidate.tmdbId, n, deadline).catch((err: unknown) => {
      // Running out of budget is not a season that failed to load. Treating it
      // as one would write PARTIAL and stamp metadataSyncedAt, sending a title
      // to the back of the queue with half its seasons read; abandoning the
      // whole title leaves it where it is, first in line tomorrow.
      if (err instanceof SyncBudgetExhaustedError) throw err;
      return null;
    }),
  );
  const seasons = fetched.filter((s): s is TmdbSeasonDetails => s !== null);
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
        SELECT id FROM "Title" WHERE id = ${candidate.id} AND "userId" = ${userId} FOR UPDATE`;
      if (!locked[0]) return null; // deleted or purged concurrently

      const newEpisodes = await upsertSeasons(tx, candidate, seasons, now);

      // Recount from the rows that exist rather than trusting TMDB's
      // number_of_episodes: a partial season load, or an episode TMDB dropped,
      // would otherwise leave the progress bar quoting a total nothing backs.
      const totalEpisodes = await tx.episode.count({
        where: { season: { titleId: candidate.id } },
      });
      const watchedEpisodes = await tx.episode.count({
        where: { season: { titleId: candidate.id }, watched: true },
      });

      await tx.title.update({
        where: { id: candidate.id },
        data: {
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
            : `${seasonNumbers.length - seasons.length} of ${seasonNumbers.length} seasons could not be loaded from TMDB.`,
          // WatchStatus is deliberately untouched. A new season arriving does
          // not un-watch a show the owner finished — the "New episodes" badge
          // is how that gets surfaced, and flipping the status here would
          // silently overwrite a choice they made by hand.
          // Provider ids are cached here ahead of a consumer: nothing in the
          // app reads them yet (nor User.myProviders), so this is the sync
          // filling the column so the data is already warm whenever the
          // "what can I watch tonight" view is built. Cheap to keep — it rides
          // along on a request the sync makes anyway.
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

    const byEpisodeNumber = new Map(current.episodes.map((e) => [e.episodeNumber, e]));
    const toCreate: Prisma.EpisodeCreateManyInput[] = [];
    for (const ep of episodes) {
      const fresh = episodeFieldsFromTmdb(ep);
      const row = byEpisodeNumber.get(ep.episode_number);
      if (!row) {
        toCreate.push({
          seasonId: current.id,
          episodeNumber: ep.episode_number,
          ...fresh,
          // An episode appearing inside a season we already hold is usually the
          // "this just showed up" case the badge exists for — but the same gap
          // opens when an old episode was never stored, so it is judged by its
          // air date like any other created row.
          discoveredAt: discoveredAtForNewEpisode(fresh.airDate, title.createdAt, now),
        });
        continue;
      }
      if (!episodeUnchanged(row, fresh)) {
        await tx.episode.update({ where: { id: row.id }, data: fresh });
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
  failed: number;
  /** Titles not started, or abandoned mid-fetch, because the run ran out of time. */
  skipped: number;
  /** Episode rows materialized for the first time across the whole run. */
  newEpisodes: number;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

/** Refresh one owner's TV metadata. Safe to call repeatedly; it is idempotent. */
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

  const candidates = await selectCandidates(userId, limit);
  const now = new Date();

  const outcomes = await mapLimit<SyncCandidate, TitleSyncOutcome | null>(
    candidates,
    concurrency,
    async (candidate) => {
      if (Date.now() >= deadline) return null;
      try {
        return await syncOneTitle(userId, region, candidate, now, deadline);
      } catch (err) {
        // A title abandoned because the budget ran out is skipped, not failed:
        // nothing is wrong with it, and recording FAILED would both stamp
        // metadataSyncedAt — losing its place at the head of the queue — and
        // report a problem the owner cannot act on.
        if (err instanceof SyncBudgetExhaustedError) return null;
        const message = errorMessage(err);
        console.error(
          `metadata sync failed (titleId=${candidate.id}, tmdbId=${candidate.tmdbId}):`,
          err,
        );
        // Recording the failure must not itself abort the run — if the database
        // is the thing that is unwell, the next title will report it too.
        await recordFailure(userId, candidate.id, message, new Date()).catch(
          (writeErr) => {
            console.error(
              `metadata sync could not record failure (titleId=${candidate.id}):`,
              writeErr,
            );
          },
        );
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

  const result: SyncRunResult = {
    userId,
    considered: candidates.length,
    synced: 0,
    failed: 0,
    skipped: 0,
    newEpisodes: 0,
  };
  for (const outcome of outcomes) {
    if (outcome === null) {
      result.skipped++;
      continue;
    }
    if (outcome.state === MetadataSyncState.FAILED) result.failed++;
    else if (outcome.state !== "VANISHED") result.synced++;
    result.newEpisodes += outcome.newEpisodes;
  }
  return result;
}

export interface ScheduledSyncResult {
  startedAt: string;
  durationMs: number;
  users: SyncRunResult[];
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
    results.push(await syncUserMetadata(user.id, { ...options, deadline }));
  }

  return {
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    users: results,
  };
}
