import { prisma } from "@/lib/prisma";
import { MediaType, WatchStatus } from "@/generated/prisma/client";
import {
  getMovie,
  getSeasons,
  getTv,
  MAX_APPENDED_SEASONS,
  searchByType,
  type TmdbSearchItem,
  type TmdbSeasonDetails,
} from "@/lib/tmdb";
import { pickBest } from "@/lib/tmdb-match";
import { mapLimit } from "@/lib/async";
import { chunks, tvRuntime } from "@/lib/rematch-history";
import { parseWatchedWorkbook, type ParsedTitle } from "./parse-excel";

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  matched: number;
  unmatched: string[];
  /** Titles that matched but whose persist threw — surfaced so failures aren't
   * silently counted as successes (the web path has no log callback). */
  failed: { name: string; reason: string }[];
  /** Titles that were created/updated but whose TMDB season enrichment was only
   * partial (one or more seasons failed to load), so their episode structure is
   * incomplete until a metadata refresh. Distinct from `failed`, which is for
   * hard errors that persisted nothing. */
  incompleteMetadata: number;
  seasons: number;
  episodes: number;
}

type Logger = (msg: string) => void;

const STATUS_MAP: Record<ParsedTitle["status"], WatchStatus> = {
  WATCHED: WatchStatus.WATCHED,
  PARTIALLY_WATCHED: WatchStatus.WATCHING,
  UNWATCHED: WatchStatus.WATCHLIST,
};

function yearOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const y = Number(iso.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

function toDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function sameDate(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

interface EpisodeMeta {
  tmdbId: number | null;
  name: string | null;
  overview: string | null;
  airDate: Date | null;
  runtime: number | null;
  stillPath: string | null;
}

/** True when none of the fields the episode-metadata update writes have
 * changed, so the caller can skip the write entirely (and never touch
 * `watched`/`watchedAt`, which this comparison — and the update — omit). */
function episodeMetaUnchanged(existing: EpisodeMeta, next: EpisodeMeta): boolean {
  return (
    existing.tmdbId === next.tmdbId &&
    existing.name === next.name &&
    existing.overview === next.overview &&
    sameDate(existing.airDate, next.airDate) &&
    existing.runtime === next.runtime &&
    existing.stillPath === next.stillPath
  );
}

/** Minimal concurrency limiter. */
function pLimit(concurrency: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return function run<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        fn().then(resolve, reject).finally(next);
      };
      if (active < concurrency) start();
      else queue.push(start);
    });
  };
}

interface EnrichedTitle {
  parsed: ParsedTitle;
  tmdb: TmdbSearchItem | null;
}

type MovieDetail = Awaited<ReturnType<typeof getMovie>>;
type TvDetail = Awaited<ReturnType<typeof getTv>>;
type FetchedSeason = { n: number; sd: TmdbSeasonDetails };
/** A TV title's fetched details plus every season that loaded. `incomplete` is
 * true when one or more listed seasons failed to fetch. */
type TvFetch = { tv: TvDetail; seasons: FetchedSeason[]; incomplete: boolean };

/** The write plan for one row, decided before any detail fetch so dedup stays
 * deterministic (see importParsedTitles). */
type PlannedTitle =
  | { kind: "unmatched"; p: ParsedTitle; mediaType: MediaType; status: WatchStatus }
  | {
      kind: "matched";
      p: ParsedTitle;
      mediaType: MediaType;
      status: WatchStatus;
      tmdbId: number;
    };

/** A planned row with its TMDB details already fetched (or a fetch error
 * captured). Produced by the concurrent fetch phase, consumed by the sequential
 * write phase. */
type PreparedTitle =
  | { kind: "unmatched"; p: ParsedTitle; mediaType: MediaType; status: WatchStatus }
  | { kind: "movie"; p: ParsedTitle; status: WatchStatus; tmdbId: number; movie: MovieDetail }
  | { kind: "tv"; p: ParsedTitle; status: WatchStatus; tmdbId: number; tv: TvFetch }
  | { kind: "fetch-failed"; p: ParsedTitle; error: unknown };

/** Client-facing reason for a per-title import failure. The raw error (which can
 * carry a TMDB response body or ORM text) is logged server-side, never returned
 * to the browser. */
const IMPORT_FAILED_REASON =
  "Celluloid couldn't load title data. Try again in a moment.";

/**
 * Bootstrap the owner's library from the legacy workbook, enriching each title
 * with TMDB metadata (and full season/episode structure for TV).
 *
 * Idempotent: re-running updates metadata but never clobbers user-set
 * `watched` / `rating` / `notes`.
 */
export async function runImport(opts: {
  ownerEmail: string;
  filePath: string;
  log?: Logger;
}): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const owner = await prisma.user.findUnique({
    where: { email: opts.ownerEmail.toLowerCase() },
  });
  if (!owner) {
    throw new Error(
      `No user found for OWNER_EMAIL="${opts.ownerEmail}". Create your account in the app (visit /login) first, then re-run the import.`,
    );
  }

  const parsed = await parseWatchedWorkbook(opts.filePath);
  log(`Parsed ${parsed.length} titles from workbook.`);
  return importParsedTitles({ userId: owner.id, parsed, log });
}

/**
 * Enrich parsed titles via TMDB and persist them for a user. Idempotent —
 * re-running updates metadata but never clobbers user-set watched/rating/notes.
 * A match that resolves to a soft-deleted (trashed) row is restored (its
 * `deletedAt` cleared) rather than silently refreshed while still hidden; the
 * restore is counted in `updated` and logged as "restored from trash: <name>".
 * Shared by the CLI workbook import and the in-app upload import.
 */
export async function importParsedTitles(opts: {
  userId: string;
  parsed: ParsedTitle[];
  log?: Logger;
}): Promise<ImportResult> {
  const log = opts.log ?? (() => {});
  const { userId, parsed } = opts;

  const limit = pLimit(6);
  const result: ImportResult = {
    total: parsed.length,
    created: 0,
    updated: 0,
    matched: 0,
    unmatched: [],
    failed: [],
    incompleteMetadata: 0,
    seasons: 0,
    episodes: 0,
  };

  // 1) Match each title against TMDB (concurrency-limited).
  const enriched: EnrichedTitle[] = await Promise.all(
    parsed.map((p) =>
      limit(async () => {
        try {
          const kind = p.mediaType;
          const year = yearOf(p.releaseDate);
          const results = await searchByType(kind, p.name, 1, { year });
          const best = pickBest(results, p.name, year);
          return { parsed: p, tmdb: best };
        } catch (err) {
          log(`  ! search failed for "${p.name}": ${(err as Error).message}`);
          return { parsed: p, tmdb: null };
        }
      }),
    ),
  );

  // 2) Build the write plan, applying dedup up front with NO network calls so the
  // "first wins" choice is deterministic regardless of fetch timing. Two parsed
  // rows can resolve to the same TMDB id (e.g. duplicate names); keep the first
  // so the second doesn't trip the (userId, mediaType, tmdbId) unique.
  const seenTmdb = new Set<string>();
  const plan: PlannedTitle[] = [];
  for (const { parsed: p, tmdb } of enriched) {
    const mediaType = p.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
    const status = STATUS_MAP[p.status];
    if (!tmdb) {
      plan.push({ kind: "unmatched", p, mediaType, status });
      continue;
    }
    const key = `${mediaType}:${tmdb.id}`;
    if (seenTmdb.has(key)) {
      log(`  ~ duplicate TMDB match for "${p.name}", skipped`);
      continue;
    }
    seenTmdb.add(key);
    plan.push({ kind: "matched", p, mediaType, status, tmdbId: tmdb.id });
  }

  // 3) Fetch full TMDB details (movie details, or TV details + every season's
  // episodes) for matched titles CONCURRENTLY, bounded so a big import doesn't
  // burst-fire at TMDB. This is the enrichment H-02 wants overlapped across
  // titles; no DB writes happen here. A total fetch failure is captured and
  // becomes a hard failure in the write phase; a partial TV season load is
  // flagged `incomplete` (counted separately, not failed).
  const prepared: PreparedTitle[] = await mapLimit(plan, 4, async (item) => {
    if (item.kind === "unmatched") return item;
    try {
      if (item.mediaType === MediaType.MOVIE) {
        const movie = await getMovie(item.tmdbId);
        return {
          kind: "movie",
          p: item.p,
          status: item.status,
          tmdbId: item.tmdbId,
          movie,
        };
      }
      const tv = await fetchTvData(item.tmdbId, item.p.name, log);
      return { kind: "tv", p: item.p, status: item.status, tmdbId: item.tmdbId, tv };
    } catch (error) {
      return { kind: "fetch-failed", p: item.p, error };
    }
  });

  // 4) Persist SEQUENTIALLY so only one transaction is ever open at a time and
  // the dedup/idempotency guarantees above are unaffected. Details are already
  // fetched, so this phase is DB-only.
  for (const item of prepared) {
    try {
      if (item.kind === "fetch-failed") throw item.error;
      if (item.kind === "unmatched") {
        result.unmatched.push(`${item.p.name} (${item.p.source})`);
        const { created, restored } = await upsertUnmatched(
          userId,
          item.p,
          item.mediaType,
          item.status,
        );
        if (created) result.created++;
        else result.updated++;
        log(`  ? no TMDB match: "${item.p.name}", added with workbook data only`);
        if (restored) log(`  ~ restored from trash: ${item.p.name}`);
        continue;
      }
      // Count as matched only AFTER the write succeeds: the web path passes no
      // log callback, so a swallowed write error would otherwise inflate the
      // success count with titles that never landed.
      if (item.kind === "movie") {
        await writeMovie(userId, item.p, item.tmdbId, item.status, item.movie, result, log);
      } else {
        await writeTv(userId, item.p, item.tmdbId, item.status, item.tv, result, log);
      }
      result.matched++;
    } catch (err) {
      // Log the raw error server-side (CLI logger + console.error for the web
      // path, which has no logger) but return only a generic reason to the
      // client — the raw text can carry a TMDB body or ORM internals.
      const raw = (err as Error).message;
      log(`  ! failed to persist "${item.p.name}": ${raw}`);
      console.error(`Import persist failed for "${item.p.name}":`, err);
      result.failed.push({ name: item.p.name, reason: IMPORT_FAILED_REASON });
    }
  }

  log(
    `Done. matched=${result.matched} unmatched=${result.unmatched.length} failed=${result.failed.length} seasons=${result.seasons} episodes=${result.episodes}`,
  );
  return result;
}

/**
 * Persist a row that TMDB couldn't match, from workbook data alone.
 * `created` is true when a new row was inserted; `restored` is true when an
 * adopted row had been in Trash and was brought back.
 */
async function upsertUnmatched(
  userId: string,
  p: ParsedTitle,
  mediaType: MediaType,
  status: WatchStatus,
): Promise<{ created: boolean; restored: boolean }> {
  const releaseDate = toDate(p.releaseDate);
  const data = {
    name: p.name,
    mediaType,
    releaseDate,
    language: p.languageHint ?? null,
    source: p.source,
  };
  // Key on name AND release date so two distinct titles that merely share a name
  // don't merge. Only adopt a prior unmatched row when exactly one candidate
  // matches; on 0 or 2+ create a fresh row rather than overwriting the wrong one.
  const candidates = await prisma.title.findMany({
    where: { userId, mediaType, name: p.name, tmdbId: null, releaseDate },
    take: 2,
    select: { id: true, deletedAt: true },
  });
  if (candidates.length === 1) {
    // Match the matched-title paths (writeMovie / writeTv): adopting a trashed
    // row must also bring it back. Without this the run reported "updated: 1"
    // while the title stayed hidden in Trash — a green success and an empty
    // library, with nothing pointing at where the row actually went.
    const restored = candidates[0].deletedAt != null;
    await prisma.title.update({
      where: { id: candidates[0].id },
      data: restored ? { ...data, deletedAt: null } : data,
    });
    return { created: false, restored };
  }
  await prisma.title.create({ data: { ...data, userId, status } });
  return { created: true, restored: false };
}

async function writeMovie(
  userId: string,
  p: ParsedTitle,
  tmdbId: number,
  status: WatchStatus,
  m: MovieDetail,
  result: ImportResult,
  log: Logger,
) {
  const meta = {
    tmdbId,
    mediaType: MediaType.MOVIE,
    name: m.title || p.name,
    originalName: m.original_title || null,
    overview: m.overview || null,
    releaseDate: toDate(m.release_date) ?? toDate(p.releaseDate),
    posterPath: m.poster_path,
    backdropPath: m.backdrop_path,
    language: m.original_language || p.languageHint || null,
    tmdbRating: m.vote_average ?? null,
    runtime: m.runtime ?? null,
    genres: m.genres?.map((g) => g.name) ?? [],
    source: p.source,
  };

  const existing = await findExistingTitle(
    userId,
    MediaType.MOVIE,
    tmdbId,
    p.name,
    toDate(p.releaseDate),
  );
  if (existing) {
    // findExistingTitle can resolve to a soft-deleted row (a trashed title still
    // occupies the (userId, mediaType, tmdbId) slot, and the unmatched-name
    // fallback can adopt a trashed row too) — mirror addFromTmdb's restore
    // semantics so a re-import doesn't refresh a title the user still can't see.
    const restoring = existing.deletedAt != null;
    await prisma.title.update({
      where: { id: existing.id },
      data: restoring ? { ...meta, deletedAt: null } : meta,
    });
    result.updated++;
    if (restoring) log(`  ↺ restored from trash: ${meta.name}`);
  } else {
    // Import doesn't backfill a watch date (the workbook has none).
    await prisma.title.create({ data: { ...meta, userId, status } });
    result.created++;
  }
  log(`  ✓ movie: ${meta.name}`);
}

/**
 * Locate the row to update for a matched title: first by (user, type, tmdbId),
 * then adopt any previously-unmatched row with the same name (so a title that
 * was unmatched on an earlier run converges instead of duplicating).
 *
 * The `@@unique([userId, mediaType, tmdbId])` constraint isn't filtered by
 * `deletedAt`, so a soft-deleted (trashed) row still occupies that slot and can
 * be returned here — callers MUST branch on the caller-side `existing` check
 * (update vs. create) exactly as today and additionally clear `deletedAt` when
 * restoring it, never fall through to `create`, or the write collides with the
 * unique constraint and a hidden row's re-import gets misreported as a failure.
 */
async function findExistingTitle(
  userId: string,
  mediaType: MediaType,
  tmdbId: number,
  name: string,
  releaseDate: Date | null,
) {
  const byTmdb = await prisma.title.findUnique({
    where: { userId_mediaType_tmdbId: { userId, mediaType, tmdbId } },
  });
  if (byTmdb) return byTmdb;
  // Adopt a previously-unmatched row only when name AND release date pin down a
  // single unambiguous candidate; otherwise return null so the caller creates a
  // new row instead of overwriting a same-named but distinct title.
  const candidates = await prisma.title.findMany({
    where: { userId, mediaType, name, tmdbId: null, releaseDate },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0] : null;
}

export function deriveStatus(
  base: WatchStatus,
  watched: number,
  total: number,
): WatchStatus {
  if (base === WatchStatus.DROPPED || base === WatchStatus.ON_HOLD) return base;
  if (total > 0 && watched >= total) return WatchStatus.WATCHED;
  if (watched > 0) return WatchStatus.WATCHING;
  // Nothing marked watched — keep the imported intent (e.g. a "watching" show
  // whose per-episode progress is unknown stays WATCHING, not WATCHLIST).
  return base;
}

/**
 * Fetch a TV title's details and every released season's episodes from TMDB
 * (network only, no DB writes) so this enrichment can overlap across titles.
 * Seasons load up to 20 per request. Best-effort per request: one that fails
 * is skipped and logged, and `incomplete` is set so the caller can flag the
 * title's enrichment as partial. Season 0 / specials are excluded by the
 * season_number >= 1 filter.
 */
async function fetchTvData(
  tmdbId: number,
  fallbackName: string,
  log: Logger,
): Promise<TvFetch> {
  const tv = await getTv(tmdbId);
  const listed = tv.seasons
    .filter((s) => s.season_number >= 1)
    .sort((a, b) => a.season_number - b.season_number);

  const seasons: FetchedSeason[] = [];
  for (const chunk of chunks(listed, MAX_APPENDED_SEASONS)) {
    try {
      seasons.push(...(await getSeasons(tmdbId, chunk)));
    } catch (err) {
      log(
        `    ! seasons ${chunk.map((s) => s.season_number).join(", ")} fetch failed for ${tv.name || fallbackName}: ${(err as Error).message}`,
      );
    }
  }
  return { tv, seasons, incomplete: seasons.length < listed.length };
}

async function writeTv(
  userId: string,
  p: ParsedTitle,
  tmdbId: number,
  status: WatchStatus,
  fetched: TvFetch,
  result: ImportResult,
  log: Logger,
) {
  const { tv, seasons, incomplete } = fetched;
  const releasedSeasons = p.tv?.releasedSeasons ?? null;

  const meta = {
    tmdbId,
    mediaType: MediaType.TV,
    name: tv.name || p.name,
    originalName: tv.original_name || null,
    overview: tv.overview || null,
    releaseDate: toDate(tv.first_air_date) ?? toDate(p.releaseDate),
    posterPath: tv.poster_path,
    backdropPath: tv.backdrop_path,
    language: tv.original_language || p.languageHint || null,
    tmdbRating: tv.vote_average ?? null,
    // As in the app's add and refresh (TM-11): TMDB's stated runtime, else the
    // median of the loaded episodes' runtimes.
    runtime: tvRuntime(
      tv.episode_run_time,
      seasons.map((s) => s.sd),
    ),
    genres: tv.genres?.map((g) => g.name) ?? [],
    totalSeasons: tv.number_of_seasons ?? null,
    // totalEpisodes is reconciled from the episode rows we actually persist
    // (below), so the progress denominator always matches what's tracked.
    source: p.source,
  };

  const existing = await findExistingTitle(
    userId,
    MediaType.TV,
    tmdbId,
    p.name,
    toDate(p.releaseDate),
  );

  // Persist the title, its seasons/episodes, and the reconciled counters in one
  // transaction so a partial failure (e.g. a mid-write timeout) can't leave the
  // denormalized totalEpisodes/watchedEpisodes out of sync with the rows. Writes
  // run sequentially (see importParsedTitles' write phase), so only one such
  // transaction is ever open at a time — the concurrency is all in the earlier
  // fetch phase.
  const { isNew, restored, epTotal, epWatched } = await prisma.$transaction(
    async (tx) => {
      const isNew = !existing;
      // Same restore semantics as writeMovie: a trashed row can still occupy the
      // (userId, mediaType, tmdbId) slot (or be adopted via the unmatched-name
      // fallback), so clear deletedAt in the same update instead of silently
      // refreshing a hidden title.
      const restored = !isNew && existing.deletedAt != null;
      const title = existing
        ? await tx.title.update({
            where: { id: existing.id },
            data: restored ? { ...meta, deletedAt: null } : meta,
          })
        : await tx.title.create({ data: { ...meta, userId, status } });

      for (const { n, sd } of seasons) {
        const season = await tx.season.upsert({
          where: { titleId_seasonNumber: { titleId: title.id, seasonNumber: n } },
          create: {
            titleId: title.id,
            tmdbId: sd.id,
            seasonNumber: n,
            name: sd.name || null,
            overview: sd.overview || null,
            airDate: toDate(sd.air_date),
            posterPath: sd.poster_path,
            episodeCount: sd.episodes?.length ?? null,
          },
          update: {
            tmdbId: sd.id,
            name: sd.name || null,
            overview: sd.overview || null,
            airDate: toDate(sd.air_date),
            posterPath: sd.poster_path,
            episodeCount: sd.episodes?.length ?? null,
          },
        });

        // Heuristic for which episodes were watched (applied to NEW rows only):
        //  - WATCHED show   → all episodes watched
        //  - WATCHING show  → episodes in seasons 1..releasedSeasons watched
        //                     (the workbook's "partially watched" = caught up on
        //                      released seasons, waiting on pending ones)
        const markWatched =
          status === WatchStatus.WATCHED ||
          (status === WatchStatus.WATCHING && releasedSeasons != null && n <= releasedSeasons);

        const episodes = sd.episodes ?? [];
        // Which episode rows already exist? Split new vs existing so we can
        // bulk-insert the new ones (collapsing the per-episode upsert N+1) and
        // only refresh metadata on the rest — never touching their `watched`
        // state, so a re-import can't clobber the user's progress. Fetch full
        // metadata (not just episodeNumber) so unchanged rows can be skipped
        // below instead of round-tripping a no-op update for every episode.
        const existingEps = await tx.episode.findMany({
          where: { seasonId: season.id },
          select: {
            episodeNumber: true,
            tmdbId: true,
            name: true,
            overview: true,
            airDate: true,
            runtime: true,
            stillPath: true,
          },
        });
        const existingByNum = new Map(existingEps.map((e) => [e.episodeNumber, e]));

        const toCreate = episodes.filter((ep) => !existingByNum.has(ep.episode_number));
        if (toCreate.length) {
          await tx.episode.createMany({
            data: toCreate.map((ep) => ({
              seasonId: season.id,
              tmdbId: ep.id,
              episodeNumber: ep.episode_number,
              name: ep.name || null,
              overview: ep.overview || null,
              airDate: toDate(ep.air_date),
              runtime: ep.runtime ?? null,
              stillPath: ep.still_path,
              watched: markWatched,
            })),
            skipDuplicates: true,
          });
        }
        for (const ep of episodes) {
          const existingEp = existingByNum.get(ep.episode_number);
          if (!existingEp) continue;
          const nextMeta: EpisodeMeta = {
            tmdbId: ep.id,
            name: ep.name || null,
            overview: ep.overview || null,
            airDate: toDate(ep.air_date),
            runtime: ep.runtime ?? null,
            stillPath: ep.still_path,
          };
          // Nothing changed — skip the write. Re-importing a large, unchanged
          // show would otherwise re-run one tx.episode.update per episode and
          // risk blowing the transaction's timeout.
          if (episodeMetaUnchanged(existingEp, nextMeta)) continue;
          await tx.episode.update({
            where: {
              seasonId_episodeNumber: {
                seasonId: season.id,
                episodeNumber: ep.episode_number,
              },
            },
            // Metadata only — deliberately omits `watched`/`watchedAt`.
            data: nextMeta,
          });
        }
      }

      // Reconcile denormalized counters from the source of truth (the episode
      // rows) so totalEpisodes matches watchedEpisodes' basis and stays correct
      // on re-imports that add newly-aired episodes.
      const [epTotal, epWatched] = await Promise.all([
        tx.episode.count({ where: { season: { titleId: title.id } } }),
        tx.episode.count({ where: { season: { titleId: title.id }, watched: true } }),
      ]);
      await tx.title.update({
        where: { id: title.id },
        data: {
          totalEpisodes: epTotal,
          watchedEpisodes: epWatched,
          // Only derive/override status on a fresh import; never clobber edits.
          ...(isNew ? { status: deriveStatus(status, epWatched, epTotal) } : {}),
        },
      });

      return { isNew, restored, epTotal, epWatched };
    },
    { timeout: 20000 },
  );

  // Apply run counters only after the transaction commits, so a rolled-back
  // title never inflates the totals.
  if (isNew) result.created++;
  else result.updated++;
  if (restored) log(`  ↺ restored from trash: ${meta.name}`);
  // A title whose seasons only partially loaded is created/updated (its progress
  // and metadata are still useful), but flagged so the caller can tell the user
  // some episode data is missing until a refresh — distinct from a hard failure.
  if (incomplete) result.incompleteMetadata++;
  result.seasons += seasons.length;
  result.episodes += seasons.reduce((sum, s) => sum + (s.sd.episodes?.length ?? 0), 0);

  log(
    `  ✓ tv: ${meta.name} (${seasons.length} seasons, ${epWatched}/${epTotal} eps)`,
  );
}

/** CLI entrypoint helper. */
export async function runImportFromEnv(log: Logger = console.log) {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) throw new Error("OWNER_EMAIL is not set.");
  const filePath = process.env.IMPORT_FILE ?? "data/watched.xlsx";
  return runImport({ ownerEmail, filePath, log });
}
