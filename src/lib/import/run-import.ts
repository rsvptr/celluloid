import { prisma } from "@/lib/prisma";
import { MediaType, WatchStatus } from "@/generated/prisma/client";
import {
  getMovie,
  getSeason,
  getTv,
  searchByType,
  type TmdbSearchItem,
} from "@/lib/tmdb";
import { pickBest } from "@/lib/tmdb-match";
import { parseWatchedWorkbook, type ParsedTitle } from "./parse-excel";

export interface ImportResult {
  total: number;
  created: number;
  updated: number;
  matched: number;
  unmatched: string[];
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
    seasons: 0,
    episodes: 0,
  };

  // 1) Match each title against TMDB (concurrency-limited).
  const enriched: EnrichedTitle[] = await Promise.all(
    parsed.map((p) =>
      limit(async () => {
        try {
          const kind = p.mediaType;
          const results = await searchByType(kind, p.name);
          const best = pickBest(results, p.name, yearOf(p.releaseDate));
          return { parsed: p, tmdb: best };
        } catch (err) {
          log(`  ! search failed for "${p.name}": ${(err as Error).message}`);
          return { parsed: p, tmdb: null };
        }
      }),
    ),
  );

  // 2) Persist each, fetching full details + episodes for matched TV.
  // Two parsed rows can resolve to the same TMDB id (e.g. duplicate names); keep
  // the first so the second doesn't trip the (userId, mediaType, tmdbId) unique.
  const seenTmdb = new Set<string>();
  for (const { parsed: p, tmdb } of enriched) {
    const mediaType = p.mediaType === "tv" ? MediaType.TV : MediaType.MOVIE;
    const status = STATUS_MAP[p.status];

    try {
      if (!tmdb) {
        result.unmatched.push(`${p.name} (${p.source})`);
        const created = await upsertUnmatched(userId, p, mediaType, status);
        if (created) result.created++;
        else result.updated++;
        log(`  ? no TMDB match: "${p.name}", added with workbook data only`);
        continue;
      }

      const key = `${mediaType}:${tmdb.id}`;
      if (seenTmdb.has(key)) {
        log(`  ~ duplicate TMDB match for "${p.name}", skipped`);
        continue;
      }
      seenTmdb.add(key);

      result.matched++;
      if (mediaType === MediaType.MOVIE) {
        await persistMovie(userId, p, tmdb.id, status, result, log);
      } else {
        await persistTv(userId, p, tmdb.id, status, result, log);
      }
    } catch (err) {
      log(`  ! failed to persist "${p.name}": ${(err as Error).message}`);
    }
  }

  log(
    `Done. matched=${result.matched} unmatched=${result.unmatched.length} seasons=${result.seasons} episodes=${result.episodes}`,
  );
  return result;
}

/** Returns true if a new row was created, false if an existing row was updated. */
async function upsertUnmatched(
  userId: string,
  p: ParsedTitle,
  mediaType: MediaType,
  status: WatchStatus,
): Promise<boolean> {
  const existing = await prisma.title.findFirst({
    where: { userId, mediaType, name: p.name, tmdbId: null },
  });
  const data = {
    name: p.name,
    mediaType,
    releaseDate: toDate(p.releaseDate),
    language: p.languageHint ?? null,
    source: p.source,
  };
  if (existing) {
    await prisma.title.update({ where: { id: existing.id }, data });
    return false;
  }
  await prisma.title.create({ data: { ...data, userId, status } });
  return true;
}

async function persistMovie(
  userId: string,
  p: ParsedTitle,
  tmdbId: number,
  status: WatchStatus,
  result: ImportResult,
  log: Logger,
) {
  const m = await getMovie(tmdbId);
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

  const existing = await findExistingTitle(userId, MediaType.MOVIE, tmdbId, p.name);
  if (existing) {
    await prisma.title.update({ where: { id: existing.id }, data: meta });
    result.updated++;
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
 */
async function findExistingTitle(
  userId: string,
  mediaType: MediaType,
  tmdbId: number,
  name: string,
) {
  const byTmdb = await prisma.title.findUnique({
    where: { userId_mediaType_tmdbId: { userId, mediaType, tmdbId } },
  });
  if (byTmdb) return byTmdb;
  return prisma.title.findFirst({
    where: { userId, mediaType, name, tmdbId: null },
  });
}

function deriveStatus(
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

async function persistTv(
  userId: string,
  p: ParsedTitle,
  tmdbId: number,
  status: WatchStatus,
  result: ImportResult,
  log: Logger,
) {
  const tv = await getTv(tmdbId);
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
    runtime: tv.episode_run_time?.[0] ?? null,
    genres: tv.genres?.map((g) => g.name) ?? [],
    totalSeasons: tv.number_of_seasons ?? null,
    // totalEpisodes is reconciled from the episode rows we actually persist
    // (below), so the progress denominator always matches what's tracked.
    source: p.source,
  };

  const existing = await findExistingTitle(userId, MediaType.TV, tmdbId, p.name);

  const isNew = !existing;
  const title = existing
    ? await prisma.title.update({ where: { id: existing.id }, data: meta })
    : await prisma.title.create({ data: { ...meta, userId, status } });
  if (isNew) result.created++;
  else result.updated++;

  // Seasons + episodes (skip season 0 / specials).
  const seasonNumbers = tv.seasons
    .map((s) => s.season_number)
    .filter((n) => n >= 1)
    .sort((a, b) => a - b);

  for (const n of seasonNumbers) {
    let sd;
    try {
      sd = await getSeason(tmdbId, n);
    } catch (err) {
      log(`    ! season ${n} fetch failed for ${meta.name}: ${(err as Error).message}`);
      continue;
    }

    const season = await prisma.season.upsert({
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
    result.seasons++;

    // Heuristic for which episodes were watched (only when creating fresh):
    //  - WATCHED show   → all episodes watched
    //  - WATCHING show  → episodes in seasons 1..releasedSeasons watched
    //                     (the workbook's "partially watched" = caught up on
    //                      released seasons, waiting on pending ones)
    const markWatched =
      status === WatchStatus.WATCHED ||
      (status === WatchStatus.WATCHING && releasedSeasons != null && n <= releasedSeasons);

    for (const ep of sd.episodes ?? []) {
      const epData = {
        tmdbId: ep.id,
        name: ep.name || null,
        overview: ep.overview || null,
        airDate: toDate(ep.air_date),
        runtime: ep.runtime ?? null,
        stillPath: ep.still_path,
      };
      await prisma.episode.upsert({
        where: {
          seasonId_episodeNumber: {
            seasonId: season.id,
            episodeNumber: ep.episode_number,
          },
        },
        // Only set watched state on creation so re-imports never clobber edits.
        create: {
          ...epData,
          seasonId: season.id,
          episodeNumber: ep.episode_number,
          watched: markWatched,
        },
        update: epData,
      });
      result.episodes++;
    }
  }

  // Reconcile denormalized counters from the source of truth (the episode rows
  // we just persisted) so totalEpisodes matches watchedEpisodes' basis, and the
  // counter stays correct on re-imports that add newly-aired episodes.
  const [epTotal, epWatched] = await Promise.all([
    prisma.episode.count({ where: { season: { titleId: title.id } } }),
    prisma.episode.count({ where: { season: { titleId: title.id }, watched: true } }),
  ]);

  await prisma.title.update({
    where: { id: title.id },
    data: {
      totalEpisodes: epTotal,
      watchedEpisodes: epWatched,
      // Only derive/override status on a fresh import; never clobber edits.
      ...(isNew ? { status: deriveStatus(status, epWatched, epTotal) } : {}),
    },
  });

  log(
    `  ✓ tv: ${meta.name} (${seasonNumbers.length} seasons, ${epWatched}/${epTotal} eps)`,
  );
}

/** CLI entrypoint helper. */
export async function runImportFromEnv(log: Logger = console.log) {
  const ownerEmail = process.env.OWNER_EMAIL;
  if (!ownerEmail) throw new Error("OWNER_EMAIL is not set.");
  const filePath = process.env.IMPORT_FILE ?? "data/watched.xlsx";
  return runImport({ ownerEmail, filePath, log });
}
