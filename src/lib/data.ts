import { cache } from "react";
import { prisma } from "@/lib/prisma";
import type { MediaType } from "@/generated/prisma/client";
// Value import (not `type`): shareTitleVisibility compares against the
// WatchStatus enum member, which must exist at runtime.
import { WatchStatus } from "@/generated/prisma/client";
import { STATUS_META, languageName } from "@/lib/format";
import type { ExportRow } from "@/lib/export/format";

export interface LibraryItem {
  id: string;
  name: string;
  mediaType: MediaType;
  tmdbId: number | null;
  posterPath: string | null;
  releaseDate: string | null;
  year: number | null;
  language: string | null;
  tmdbRating: number | null;
  status: WatchStatus;
  rating: number | null;
  favorite: boolean;
  totalSeasons: number | null;
  totalEpisodes: number | null;
  watchedEpisodes: number;
  genres: string[];
  tags: string[];
  watchedAt: string | null;
  createdAt: string;
  /** Included/free/ad-supported provider ids cached by the nightly sync. */
  streamProviderIds: number[];
  providersRegion: string | null;
  providersSyncedAt: string | null;
  /** TV only: unwatched episodes that already aired and were discovered recently (D-F5). */
  hasNewEpisodes: boolean;
}

// --- "New episodes" signal (D-F5) -------------------------------------------
//
// The workflow-foundation migration (20260717221157) backfilled every
// pre-existing Episode.discoveredAt to the migration's own execution instant
// (the column was added with `DEFAULT CURRENT_TIMESTAMP`), not to when the
// episode was actually discovered. A naive "discovered in the last 14 days"
// check would therefore badge every show with an aired-but-unwatched episode
// for a full two weeks purely from that backfill artifact. Anchoring the
// window to a fixed constant set just after the migration ran excludes that
// entire backfilled cohort; only episodes discovered by genuine post-migration
// activity (a metadata refresh, a season-tracker sync, etc.) can trigger it.
const NEW_EPISODE_BACKFILL_CUTOFF = new Date("2026-07-18T00:00:00Z");
const NEW_EPISODE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** The later of (now - 14 days) and the backfill cutoff — the floor `discoveredAt` must clear. */
export function newEpisodeDiscoveredAfter(now: Date): Date {
  const windowStart = new Date(now.getTime() - NEW_EPISODE_WINDOW_MS);
  return windowStart > NEW_EPISODE_BACKFILL_CUTOFF ? windowStart : NEW_EPISODE_BACKFILL_CUTOFF;
}

export async function getLibraryItems(userId: string): Promise<LibraryItem[]> {
  const now = new Date();
  const [rows, freshTvSeasons] = await Promise.all([
    prisma.title.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ favorite: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        mediaType: true,
        tmdbId: true,
        posterPath: true,
        releaseDate: true,
        language: true,
        tmdbRating: true,
        status: true,
        rating: true,
        favorite: true,
        totalSeasons: true,
        totalEpisodes: true,
        watchedEpisodes: true,
        genres: true,
        watchedAt: true,
        createdAt: true,
        streamProviderIds: true,
        providersRegion: true,
        providersSyncedAt: true,
        tags: { select: { tag: { select: { name: true } } } },
      },
    }),
    // Single extra query (not per-row): every TV title with at least one
    // unwatched, already-aired episode discovered inside the fresh window.
    //
    // Raw SQL because the last predicate compares two COLUMNS, which Prisma's
    // filter language cannot express. It is what makes the badge mean anything:
    // adding a show writes all of its episode rows at once with discoveredAt =
    // now, so a purely time-based window flagged every freshly added series —
    // including one that finished airing a decade ago — as having new episodes,
    // for the whole length of the window. An episode is only NEW to the owner
    // if it arrived after the title itself did. The one-minute grace absorbs the
    // gap between creating the Title row and writing its episodes in the same
    // add, which are milliseconds apart but not simultaneous.
    prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT t.id
      FROM "Title" t
      JOIN "Season" s ON s."titleId" = t.id
      JOIN "Episode" e ON e."seasonId" = s.id
      WHERE t."userId" = ${userId}
        AND t."deletedAt" IS NULL
        AND t."mediaType" = 'TV'::"MediaType"
        AND e.watched = false
        AND e."airDate" IS NOT NULL
        AND e."airDate" <= ${now}
        AND e."discoveredAt" > ${newEpisodeDiscoveredAfter(now)}
        AND e."discoveredAt" > t."createdAt" + interval '1 minute'`,
  ]);
  const newEpisodeTitleIds = new Set(freshTvSeasons.map((t) => t.id));

  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    mediaType: t.mediaType,
    tmdbId: t.tmdbId,
    posterPath: t.posterPath,
    releaseDate: t.releaseDate ? t.releaseDate.toISOString() : null,
    year: t.releaseDate ? t.releaseDate.getUTCFullYear() : null,
    language: t.language,
    tmdbRating: t.tmdbRating,
    status: t.status,
    rating: t.rating,
    favorite: t.favorite,
    totalSeasons: t.totalSeasons,
    totalEpisodes: t.totalEpisodes,
    watchedEpisodes: t.watchedEpisodes,
    genres: t.genres,
    tags: t.tags.map((x) => x.tag.name),
    watchedAt: t.watchedAt ? t.watchedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    streamProviderIds: t.streamProviderIds,
    providersRegion: t.providersRegion,
    providersSyncedAt: t.providersSyncedAt?.toISOString() ?? null,
    hasNewEpisodes: newEpisodeTitleIds.has(t.id),
  }));
}

export interface LibraryProviderPreferences {
  watchRegion: string;
  myProviders: number[];
}

/** Small owner preference read kept separate from the much wider account card. */
export async function getLibraryProviderPreferences(
  userId: string,
): Promise<LibraryProviderPreferences | null> {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { watchRegion: true, myProviders: true },
  });
}

export interface TitleIndexEntry {
  id: string;
  name: string;
  year: number | null;
  mediaType: MediaType;
  posterPath: string | null;
}

/** Lightweight list for the command palette. */
export async function getTitleIndex(userId: string): Promise<TitleIndexEntry[]> {
  const rows = await prisma.title.findMany({
    where: { userId, deletedAt: null },
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      releaseDate: true,
      mediaType: true,
      posterPath: true,
    },
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    year: t.releaseDate ? t.releaseDate.getUTCFullYear() : null,
    mediaType: t.mediaType,
    posterPath: t.posterPath,
  }));
}

export interface TrashedTitle {
  id: string;
  name: string;
  mediaType: MediaType;
  posterPath: string | null;
  deletedAt: string; // ISO timestamp of the soft delete
}

/** Soft-deleted titles for the library's Trash view, most recently deleted first. */
export async function getTrashedTitles(userId: string): Promise<TrashedTitle[]> {
  const rows = await prisma.title.findMany({
    where: { userId, deletedAt: { not: null } },
    orderBy: { deletedAt: "desc" },
    select: {
      id: true,
      name: true,
      mediaType: true,
      posterPath: true,
      deletedAt: true,
    },
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    mediaType: t.mediaType,
    posterPath: t.posterPath,
    // deletedAt is non-null by the where filter above; the assertion is safe.
    deletedAt: t.deletedAt!.toISOString(),
  }));
}

export interface UserPrefs {
  timeZone: string;
  watchRegion: string | null;
  myProviders: number[];
  lastBackupAt: Date | null;
}

/**
 * The app-level User preference row, deduped per request with React.cache so
 * pages that need more than one of these columns (stats, settings, upcoming,
 * the title page and its extras) fetch the row once instead of once per call
 * site.
 */
export const getUserPrefs = cache(
  async (userId: string): Promise<UserPrefs | null> => {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true, watchRegion: true, myProviders: true, lastBackupAt: true },
    });
  },
);

export interface AccountInfo {
  name: string;
  email: string;
  hasApiKey: boolean;
  hasServerKey: boolean;
  twoFactorEnabled: boolean;
  recommendModel: string | null;
}

export async function getAccountInfo(userId: string): Promise<AccountInfo> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      name: true,
      email: true,
      anthropicKeyEnc: true,
      twoFactorEnabled: true,
      recommendModel: true,
    },
  });
  return {
    name: u?.name ?? "",
    email: u?.email ?? "",
    hasApiKey: !!u?.anthropicKeyEnc,
    hasServerKey: !!process.env.ANTHROPIC_API_KEY,
    twoFactorEnabled: !!u?.twoFactorEnabled,
    recommendModel: u?.recommendModel ?? null,
  };
}

// --- Shareable lists -------------------------------------------------------

export interface ShareSummary {
  id: string;
  slug: string;
  name: string | null;
  count: number | null; // null = whole library (live)
  includeNotes: boolean;
  scope: "WHOLE_LIBRARY" | "SELECTION";
  expiresAt: string | null;
  revokedAt: string | null;
  state: ShareLifecycleState;
  createdAt: string;
}

export async function getUserShareLists(userId: string): Promise<ShareSummary[]> {
  const rows = await prisma.shareList.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      slug: true,
      name: true,
      titleIds: true,
      includeNotes: true,
      scope: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
      items: {
        orderBy: { position: "asc" },
        select: { titleId: true },
      },
    },
  });

  // titleIds is a denormalized snapshot that isn't pruned when a title is
  // deleted, so its raw length overstates what the share actually renders
  // (getSharePayload joins against owned titles). Reconcile against the titles
  // the user still owns with a single query, then count the intersection.
  const referencedIds = [
    ...new Set(
      rows.flatMap((r) =>
        r.scope === "SELECTION"
          ? r.items.length > 0
            ? r.items.map((item) => item.titleId)
            : r.titleIds
          : [],
      ),
    ),
  ];
  const ownedIds =
    referencedIds.length > 0
      ? new Set(
          (
            await prisma.title.findMany({
              where: { userId, deletedAt: null, id: { in: referencedIds } },
              select: { id: true },
            })
          ).map((t) => t.id),
        )
      : new Set<string>();

  const now = new Date();
  return rows.map((r) => {
    const selectedIds =
      r.items.length > 0 ? r.items.map((item) => item.titleId) : r.titleIds;
    return {
      id: r.id,
      slug: r.slug,
      name: r.name,
      count:
        r.scope === "WHOLE_LIBRARY"
          ? null
          : selectedIds.filter((id) => ownedIds.has(id)).length,
      includeNotes: r.includeNotes,
      scope: r.scope,
      expiresAt: r.expiresAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      state: shareLifecycleState(r, now),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export interface ShareItem {
  id: string;
  name: string;
  mediaType: MediaType;
  posterPath: string | null;
  year: number | null;
  language: string | null;
  tmdbRating: number | null;
  status: WatchStatus;
  rating: number | null;
  favorite: boolean;
  totalEpisodes: number | null;
  watchedEpisodes: number;
  notes: string | null;
}

export interface SharePayload {
  name: string | null;
  ownerName: string;
  includeNotes: boolean;
  items: ShareItem[];
}

export interface ShareVisibilityConfig {
  /** True when the share is the whole library (empty titleIds selection). */
  isWholeLibrary: boolean;
  /** Whole-library shares only: include not-yet-watched WATCHLIST titles. */
  includeWatchlist: boolean;
  /** Expose per-title notes (private by default). */
  includeNotes: boolean;
}

/**
 * Pure privacy decision for one title in a shared list — extracted so the rules
 * are unit-testable without a live DB. Whole-library shares hide WATCHLIST
 * titles unless the owner opted in; explicit selections are shown regardless of
 * status. Notes, rating and favorite are personal signals of the same kind and
 * are all stripped unless includeNotes is set; status and progress stay
 * visible regardless. getSharePayload's SQL applies the same visibility
 * predicate as an efficiency pre-filter, but this helper is the authoritative
 * gate at the output boundary (defense in depth for a public, no-auth
 * endpoint).
 */
export function shareTitleVisibility(
  config: ShareVisibilityConfig,
  title: {
    status: WatchStatus;
    notes: string | null;
    rating?: number | null;
    favorite?: boolean;
  },
): { visible: boolean; notes: string | null; rating: number | null; favorite: boolean } {
  const visible =
    !config.isWholeLibrary ||
    config.includeWatchlist ||
    title.status !== WatchStatus.WATCHLIST;
  return {
    visible,
    notes: config.includeNotes ? title.notes : null,
    rating: config.includeNotes ? (title.rating ?? null) : null,
    favorite: config.includeNotes ? (title.favorite ?? false) : false,
  };
}

export type ShareLifecycleState = "ACTIVE" | "EXPIRED" | "REVOKED";

/** Stable lifecycle decision shared by public resolution and Settings. */
export function shareLifecycleState(
  share: { expiresAt: Date | null; revokedAt: Date | null },
  now = new Date(),
): ShareLifecycleState {
  if (share.revokedAt !== null) return "REVOKED";
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) {
    return "EXPIRED";
  }
  return "ACTIVE";
}

/** Public shares stop resolving as soon as they are revoked or reach expiry. */
export function shareIsAvailable(
  share: { expiresAt: Date | null; revokedAt: Date | null },
  now = new Date(),
): boolean {
  return shareLifecycleState(share, now) === "ACTIVE";
}

/** Put a selection back into its owner-curated order after an SQL `in` query. */
export function orderSharedTitles<T extends { id: string }>(
  titles: T[],
  orderedIds: string[],
): T[] {
  const byId = new Map(titles.map((title) => [title.id, title]));
  return orderedIds.flatMap((id) => {
    const title = byId.get(id);
    return title ? [title] : [];
  });
}

/**
 * Public (no-auth) resolver for /s/[slug]. Returns null if the link is unknown.
 * Wrapped in React.cache so the /s/[slug] route resolves it once per request
 * instead of twice (generateMetadata + page body).
 */
export const getSharePayload = cache(
  async (slug: string): Promise<SharePayload | null> => {
    const share = await prisma.shareList.findUnique({
      where: { slug },
      select: {
        userId: true,
        name: true,
        titleIds: true,
        includeNotes: true,
        includeWatchlist: true,
        scope: true,
        expiresAt: true,
        revokedAt: true,
        items: {
          orderBy: { position: "asc" },
          select: { titleId: true },
        },
      },
    });
    if (!share || !shareIsAvailable(share)) return null;

    const owner = await prisma.user.findUnique({
      where: { id: share.userId },
      select: { name: true },
    });

    // Explicit selections are shown exactly as picked. Whole-library shares hide
    // not-yet-watched WATCHLIST titles unless the owner opted to include them —
    // applied here in SQL as an efficiency pre-filter and re-enforced by
    // shareTitleVisibility below.
    const isWholeLibrary = share.scope === "WHOLE_LIBRARY";
    const selectedIds =
      share.items.length > 0
        ? share.items.map((item) => item.titleId)
        : share.titleIds;
    const foundTitles = await prisma.title.findMany({
      where: {
        userId: share.userId,
        deletedAt: null,
        ...(isWholeLibrary ? {} : { id: { in: selectedIds } }),
        ...(isWholeLibrary && !share.includeWatchlist
          ? { status: { not: "WATCHLIST" } }
          : {}),
      },
      ...(isWholeLibrary
        ? { orderBy: [{ favorite: "desc" as const }, { name: "asc" as const }] }
        : {}),
      select: {
        id: true,
        name: true,
        mediaType: true,
        posterPath: true,
        releaseDate: true,
        language: true,
        tmdbRating: true,
        status: true,
        rating: true,
        favorite: true,
        totalEpisodes: true,
        watchedEpisodes: true,
        notes: true,
      },
    });
    const titles = isWholeLibrary
      ? foundTitles
      : orderSharedTitles(foundTitles, selectedIds);

    const visibility: ShareVisibilityConfig = {
      isWholeLibrary,
      includeWatchlist: share.includeWatchlist,
      includeNotes: share.includeNotes,
    };
    const items: ShareItem[] = [];
    for (const t of titles) {
      const decision = shareTitleVisibility(visibility, t);
      if (!decision.visible) continue;
      items.push({
        id: t.id,
        name: t.name,
        mediaType: t.mediaType,
        posterPath: t.posterPath,
        year: t.releaseDate ? t.releaseDate.getUTCFullYear() : null,
        language: t.language,
        tmdbRating: t.tmdbRating,
        status: t.status,
        rating: decision.rating,
        favorite: decision.favorite,
        totalEpisodes: t.totalEpisodes,
        watchedEpisodes: t.watchedEpisodes,
        notes: decision.notes,
      });
    }

    return {
      name: share.name,
      ownerName: owner?.name ?? "Someone",
      includeNotes: share.includeNotes,
      items,
    };
  },
);

export async function getExportRows(userId: string): Promise<ExportRow[]> {
  const [rows, watchCounts] = await Promise.all([
    prisma.title.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ mediaType: "asc" }, { name: "asc" }],
      select: {
        id: true,
        tmdbId: true,
        name: true,
        mediaType: true,
        releaseDate: true,
        language: true,
        status: true,
        rating: true,
        tmdbRating: true,
        genres: true,
        totalEpisodes: true,
        watchedEpisodes: true,
        favorite: true,
        notes: true,
        watchedAt: true,
        createdAt: true,
        tags: { select: { tag: { select: { name: true } } } },
      },
    }),
    // How many times each title was actually completed, as one grouped pass
    // over the watch log rather than a count per exported row. EPISODE_WATCHED
    // is deliberately excluded: it counts episodes, not viewings of the show.
    prisma.watchEvent.groupBy({
      by: ["titleId"],
      where: {
        userId,
        kind: { in: ["TITLE_COMPLETED", "REWATCH"] },
        title: { deletedAt: null },
      },
      _count: { _all: true },
    }),
  ]);
  const watchCountByTitle = new Map(
    watchCounts.map((g) => [g.titleId, g._count._all]),
  );

  return rows.map((t) => ({
    id: t.id,
    tmdbId: t.tmdbId,
    name: t.name,
    mediaType: t.mediaType === "TV" ? ("tv" as const) : ("movie" as const),
    year: t.releaseDate ? t.releaseDate.getUTCFullYear() : null,
    releaseDate: t.releaseDate ? t.releaseDate.toISOString().slice(0, 10) : null,
    languageCode: t.language,
    language: languageName(t.language),
    statusKey: t.status,
    status: STATUS_META[t.status].label,
    myRating: t.rating,
    tmdbRating: t.tmdbRating,
    genres: t.genres,
    totalEpisodes: t.totalEpisodes,
    watchedEpisodes: t.watchedEpisodes,
    watchCount: watchCountByTitle.get(t.id) ?? 0,
    favorite: t.favorite,
    notes: t.notes,
    // Full ISO timestamps: never printed, only used to sort the "recent" basis
    // and the recency block, so keep sub-day precision for correct ordering.
    watchedAt: t.watchedAt ? t.watchedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    tags: t.tags.map((x) => x.tag.name),
  }));
}

// Wrapped in React.cache so a request that reads the title twice (title page
// generateMetadata + page body) hits the DB once. Both args are primitives, so
// the per-request memo key is stable.
export const getTitleDetail = cache(async (userId: string, id: string) => {
  const title = await prisma.title.findFirst({
    // deletedAt: null so a trashed title's detail page resolves to notFound().
    where: { id, userId, deletedAt: null },
    include: {
      // Seasons and episodes are selected field-by-field rather than included
      // wholesale: a long-running show has hundreds of episode rows, and each
      // carries a full `overview` paragraph the title page never renders. The
      // list below is exactly what the page maps into <SeasonTracker/> plus the
      // three fields the "new episodes" check below reads.
      seasons: {
        orderBy: { seasonNumber: "asc" },
        select: {
          id: true,
          seasonNumber: true,
          name: true,
          episodes: {
            orderBy: { episodeNumber: "asc" },
            select: {
              id: true,
              episodeNumber: true,
              name: true,
              airDate: true,
              watched: true,
              discoveredAt: true,
            },
          },
        },
      },
      tags: { include: { tag: true } },
    },
  });
  if (!title) return null;
  // D-F5 "new episodes" signal, computed from the seasons/episodes already
  // fetched above (no extra query needed here — unlike the library grid,
  // this is a single title). Same threshold rule as getLibraryItems: see the
  // NEW_EPISODE_BACKFILL_CUTOFF comment there for why the floor exists.
  const now = new Date();
  const freshAfter = newEpisodeDiscoveredAfter(now);
  // Must match getLibraryItems' predicate exactly, including the "arrived after
  // the title did" clause — otherwise a show badges in the grid and not on its
  // own page, or the reverse. See the comment on that query for why the
  // comparison against createdAt is what makes the badge meaningful.
  const addedWith = title.createdAt.getTime() + 60_000;
  const hasNewEpisodes =
    title.mediaType === "TV" &&
    title.seasons.some((s) =>
      s.episodes.some(
        (e) =>
          !e.watched &&
          e.airDate !== null &&
          e.airDate <= now &&
          e.discoveredAt > freshAfter &&
          e.discoveredAt.getTime() > addedWith,
      ),
    );
  return { ...title, hasNewEpisodes };
});

export type TitleDetail = NonNullable<Awaited<ReturnType<typeof getTitleDetail>>>;

export async function getTags(userId: string) {
  return prisma.tag.findMany({
    where: { userId },
    orderBy: { name: "asc" },
  });
}

export interface LibraryFacets {
  /** Distinct original-language codes present in the library. */
  languages: string[];
  /** Distinct genres present in the library. */
  genres: string[];
}

/** Distinct languages + genres, for the recommendation preference controls. */
export async function getLibraryFacets(userId: string): Promise<LibraryFacets> {
  const rows = await prisma.title.findMany({
    where: { userId, deletedAt: null },
    select: { language: true, genres: true },
  });
  const langs = new Set<string>();
  const genres = new Set<string>();
  for (const r of rows) {
    if (r.language) langs.add(r.language);
    for (const g of r.genres) genres.add(g);
  }
  return {
    languages: [...langs].sort(),
    genres: [...genres].sort(),
  };
}

export interface LibraryStats {
  total: number;
  movies: number;
  tv: number;
  byStatus: Record<WatchStatus, number>;
  watchedMovies: number;
  watchedEpisodes: number;
  watchTimeMinutes: number;
  /**
   * How many of the watched episodes behind `watchTimeMinutes` were counted at
   * the flat average because nothing knows their real runtime — so the page can
   * say how much of the headline number is a guess.
   */
  watchTimeEstimatedEpisodes: number;
  /**
   * Same, but for watched movies with no runtime of their own — rare (most
   * come from TMDB with `runtime` set), but otherwise counted as 0 minutes
   * and invisible in `watchTimeMinutes`.
   */
  watchTimeEstimatedMovies: number;
  byLanguage: { code: string; count: number }[];
  byDecade: { decade: string; count: number }[];
  byYear: { year: number; count: number }[];
  topRated: { id: string; name: string; rating: number }[];
  ratedCount: number;
  averageRating: number | null;
  ratingDistribution: { rating: number; count: number }[]; // ratings 1..10
  byGenre: { genre: string; count: number }[];
  /** Average of YOUR ratings per genre (genres with at least 2 rated titles). */
  byGenreRating: { genre: string; avg: number; count: number }[];
  // Watch activity: derived from the WatchEvent log (all kinds), bucketed into
  // calendar days in the owner's User.timeZone. Sparse for libraries that
  // predate event tracking (e.g. bulk-imported titles with no logged events).
  activity: { date: string; count: number }[]; // YYYY-MM-DD, owner-local
  /** Owner-local "today" as a "YYYY-MM-DD" key (see dayKeyInZone), so the
   *  heatmap can build its grid and "future" cells from the same anchor as
   *  the streaks below, rather than the viewer's own clock and time zone. */
  todayKey: string;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
  // Completion
  episodesTotal: number;
  // Rewatch activity (from WatchEvent kind REWATCH)
  totalRewatches: number;
  mostRewatched: { id: string; name: string; count: number }[]; // top 3, count >= 2
}

/**
 * Average episode length used when nothing knows an episode's real runtime.
 * Exported so the stats page can name the same number in its caveat instead of
 * hardcoding a second copy that could drift away from the arithmetic.
 */
export const ESTIMATED_EPISODE_MINUTES = 42;

/**
 * Average movie length used when a watched movie has no runtime of its own
 * (TMDB had none, or the match predates runtime capture). Exported for the
 * same reason as ESTIMATED_EPISODE_MINUTES: so the stats page can name the
 * same number in its caveat instead of hardcoding a second copy.
 */
export const ESTIMATED_MOVIE_MINUTES = 110;

/**
 * A UTC instant as the owner-local "YYYY-MM-DD" it happened on, so activity and
 * streaks bucket into the day the owner actually experienced it as, not the
 * server's UTC day. Falls back to UTC if the stored zone is empty or not a valid
 * IANA identifier (Intl throws on construction).
 */
export function dayKeyInZone(date: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  const parts = fmt.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// IANA identifiers are slash-separated alphanumeric segments ("Etc/GMT+5",
// "America/Argentina/Buenos_Aires"). Offset forms like "+05:30" are deliberately
// excluded: Intl accepts them, but Postgres reads the sign the other way round,
// so letting one through would silently shift every bucket by twice the offset.
const IANA_TIME_ZONE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/**
 * The zone getStats hands to Postgres for day bucketing. `AT TIME ZONE` errors
 * on an unknown zone, which would take the whole stats page down over a stored
 * value the owner may not even be able to see, so anything that isn't a valid
 * IANA name degrades to UTC — the same fallback dayKeyInZone applies.
 */
export function resolveTimeZone(timeZone: string): string {
  if (!IANA_TIME_ZONE.test(timeZone)) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/**
 * Current and longest run of consecutive active days, over owner-local
 * "YYYY-MM-DD" keys. Once we have a Y-M-D key, stepping by 24h on a UTC-midnight
 * parse of that key always lands on the correct adjacent calendar date
 * (Gregorian day math, independent of the origin time zone), so a DST shift in
 * the owner's zone can't split a run.
 */
export function computeStreaks(
  activeDayKeys: string[],
  todayKey: string,
): { currentStreak: number; longestStreak: number } {
  const DAY = 86_400_000;
  const daySet = new Set(activeDayKeys);
  const sorted = [...daySet].sort();

  let longestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  for (const k of sorted) {
    const t = Date.parse(`${k}T00:00:00Z`);
    run = prev !== null && t - prev === DAY ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = t;
  }

  const dayBefore = (key: string) =>
    new Date(Date.parse(`${key}T00:00:00Z`) - DAY).toISOString().slice(0, 10);
  // Today is still in progress, so an empty today doesn't end a streak —
  // yesterday is allowed as the starting point.
  let cursorKey = daySet.has(todayKey) ? todayKey : dayBefore(todayKey);
  let currentStreak = 0;
  while (daySet.has(cursorKey)) {
    currentStreak++;
    cursorKey = dayBefore(cursorKey);
  }

  return { currentStreak, longestStreak };
}

export interface ActivityDay {
  /** Owner-local "YYYY-MM-DD", matching the keys in LibraryStats.activity. */
  date: string;
  titles: { id: string; name: string; count: number }[];
  /** Titles past the per-day cap, so the panel can say how many it left out. */
  more: number;
}

/**
 * The heatmap renders 53 weeks; 400 days covers that plus the partial week the
 * grid pads with, so every clickable cell has its day available.
 */
const ACTIVITY_DETAIL_DAYS = 400;
/** Titles listed for a single day before the rest collapse into a count. */
const ACTIVITY_DAY_TITLE_CAP = 12;

/**
 * What was watched on each day of the heatmap window, so a cell can answer the
 * question it raises ("what did I watch that day?") instead of only showing a
 * count. Grouped by (day, title) in Postgres for the same reason getStats
 * buckets there: an owner who tracks episodes individually has one row per
 * episode, and streaming a year of those to count them client-side is wasteful.
 */
export async function getActivityDays(userId: string): Promise<ActivityDay[]> {
  const prefs = await getUserPrefs(userId);
  const timeZone = resolveTimeZone(prefs?.timeZone || "UTC");
  const since = new Date(Date.now() - ACTIVITY_DETAIL_DAYS * 86_400_000);
  const rows = await prisma.$queryRaw<
    { date: string; id: string; name: string; count: number }[]
  >`
    SELECT to_char(
             ((e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text)::date,
             'YYYY-MM-DD'
           ) AS "date",
           t.id AS "id",
           t.name AS "name",
           COUNT(*)::int AS "count"
    FROM "WatchEvent" e
    JOIN "Title" t ON t.id = e."titleId"
    WHERE e."userId" = ${userId}
      AND t."deletedAt" IS NULL
      AND e."occurredAt" >= ${since}
    GROUP BY 1, t.id, t.name
    ORDER BY 1 ASC, COUNT(*) DESC, t.name ASC`;

  const byDay = new Map<string, ActivityDay>();
  for (const r of rows) {
    const day = byDay.get(r.date) ?? { date: r.date, titles: [], more: 0 };
    if (day.titles.length < ACTIVITY_DAY_TITLE_CAP) {
      day.titles.push({ id: r.id, name: r.name, count: r.count });
    } else {
      day.more += 1;
    }
    byDay.set(r.date, day);
  }
  return [...byDay.values()];
}

export async function getStats(userId: string): Promise<LibraryStats> {
  // Resolved first (and deduped with getActivityDays via getUserPrefs' cache()
  // when both run in the same request) because the day-bucketing query below
  // needs a Postgres-safe zone name before it can run — see resolveTimeZone.
  // Everything else here is independent of it, so it joins the same batch
  // instead of waiting behind it.
  const prefs = await getUserPrefs(userId);
  const timeZone = resolveTimeZone(prefs?.timeZone || "UTC");

  const [titles, watchedEpisodeRuntime, mostRewatched, totalRewatches, activity] =
    await Promise.all([
      prisma.title.findMany({
        where: { userId, deletedAt: null },
        select: {
          id: true,
          name: true,
          mediaType: true,
          status: true,
          language: true,
          releaseDate: true,
          rating: true,
          runtime: true,
          totalEpisodes: true,
          watchedEpisodes: true,
          genres: true,
        },
      }),
      // Real minutes behind the watch-time KPI, plus how many watched episodes
      // have no runtime to fall back on. Excludes soft-deleted titles the same
      // way the title query does, two relations up.
      prisma.episode.aggregate({
        where: { watched: true, season: { title: { userId, deletedAt: null } } },
        _sum: { runtime: true },
        _count: { _all: true, runtime: true },
      }),
      // Top rewatched titles, grouped and truncated in SQL. `HAVING >= 2` keeps
      // a single logged rewatch out of a "most rewatched" list; the name tiebreak
      // makes an otherwise arbitrary ordering stable between page loads.
      prisma.$queryRaw<{ id: string; name: string; count: number }[]>`
        SELECT t.id AS "id", t.name AS "name", COUNT(*)::int AS "count"
        FROM "WatchEvent" e
        JOIN "Title" t ON t.id = e."titleId"
        WHERE e."userId" = ${userId}
          AND e.kind = 'REWATCH'::"WatchEventKind"
          AND t."deletedAt" IS NULL
        GROUP BY t.id, t.name
        HAVING COUNT(*) >= 2
        ORDER BY COUNT(*) DESC, t.name ASC
        LIMIT 3`,
      prisma.watchEvent.count({
        where: { userId, kind: "REWATCH", title: { deletedAt: null } },
      }),
      // Day bucketing happens in Postgres — the alternative streamed every watch
      // event the owner has ever recorded (tens of thousands of rows once
      // episodes are tracked individually) just to count them by day.
      prisma.$queryRaw<{ date: string; count: number }[]>`
        SELECT to_char(
                 ((e."occurredAt" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}::text)::date,
                 'YYYY-MM-DD'
               ) AS "date",
               COUNT(*)::int AS "count"
        FROM "WatchEvent" e
        JOIN "Title" t ON t.id = e."titleId"
        WHERE e."userId" = ${userId} AND t."deletedAt" IS NULL
        GROUP BY 1
        ORDER BY 1`,
    ]);

  const byStatus = {
    WATCHLIST: 0,
    WATCHING: 0,
    WATCHED: 0,
    ON_HOLD: 0,
    DROPPED: 0,
  } as Record<WatchStatus, number>;
  const langCount = new Map<string, number>();
  const decadeCount = new Map<string, number>();
  const yearCount = new Map<number, number>();
  const genreCount = new Map<string, number>();
  const genreRating = new Map<string, { sum: number; count: number }>();
  const ratingCount = new Array<number>(11).fill(0); // index = rating (1..10)

  let movies = 0;
  let tv = 0;
  let watchedMovies = 0;
  let watchedEpisodes = 0;
  let episodesTotal = 0;
  let watchTimeMinutes = 0;
  let watchTimeEstimatedMovies = 0;
  const rated: { id: string; name: string; rating: number }[] = [];

  for (const t of titles) {
    byStatus[t.status]++;
    if (t.mediaType === "MOVIE") {
      movies++;
      if (t.status === "WATCHED") {
        watchedMovies++;
        if (t.runtime != null) {
          watchTimeMinutes += t.runtime;
        } else {
          // No runtime to fall back on: price it flat, same as an
          // untracked episode, instead of silently adding 0.
          watchTimeEstimatedMovies++;
          watchTimeMinutes += ESTIMATED_MOVIE_MINUTES;
        }
      }
    } else {
      tv++;
      watchedEpisodes += t.watchedEpisodes;
      episodesTotal += t.totalEpisodes ?? 0;
      // TV minutes come from the episode rows below, not from Title.runtime.
    }
    if (t.language) langCount.set(t.language, (langCount.get(t.language) ?? 0) + 1);
    if (t.releaseDate) {
      const y = t.releaseDate.getUTCFullYear();
      decadeCount.set(`${Math.floor(y / 10) * 10}s`, (decadeCount.get(`${Math.floor(y / 10) * 10}s`) ?? 0) + 1);
      yearCount.set(y, (yearCount.get(y) ?? 0) + 1);
    }
    for (const g of t.genres) genreCount.set(g, (genreCount.get(g) ?? 0) + 1);
    if (t.rating != null) {
      rated.push({ id: t.id, name: t.name, rating: t.rating });
      // Half-star ratings are bucketed to the nearest whole star for the histogram.
      const b = Math.round(t.rating);
      if (b >= 1 && b <= 10) ratingCount[b]++;
      for (const g of t.genres) {
        const agg = genreRating.get(g) ?? { sum: 0, count: 0 };
        agg.sum += t.rating;
        agg.count += 1;
        genreRating.set(g, agg);
      }
    }
  }

  // TV watch time is the sum of the real per-episode runtimes of the episodes
  // marked watched. It used to be watchedEpisodes * (Title.runtime ?? 42), but
  // Title.runtime holds TMDB's episode_run_time, which is empty for most modern
  // shows — so nearly every series was priced at a flat 42 minutes, well short
  // for drama and well over for sitcoms. Episodes with no runtime of their own
  // still take the average, as do episodes the denormalized counter knows about
  // but has no row for (a restored backup that carried no episodes), and their
  // combined count is reported so the page can qualify the headline number.
  const untrackedWatchedEpisodes = Math.max(
    0,
    watchedEpisodes - watchedEpisodeRuntime._count._all,
  );
  const watchTimeEstimatedEpisodes =
    watchedEpisodeRuntime._count._all -
    watchedEpisodeRuntime._count.runtime +
    untrackedWatchedEpisodes;
  watchTimeMinutes +=
    (watchedEpisodeRuntime._sum.runtime ?? 0) +
    watchTimeEstimatedEpisodes * ESTIMATED_EPISODE_MINUTES;

  const averageRating =
    rated.length > 0
      ? rated.reduce((s, r) => s + r.rating, 0) / rated.length
      : null;

  // Zero-fill release years so the sparkline timeline is honest (no equidistant
  // jumps across gap years).
  const years = [...yearCount.keys()];
  const byYear: { year: number; count: number }[] = [];
  if (years.length > 0) {
    const minY = Math.min(...years);
    const maxY = Math.max(...years);
    for (let y = minY; y <= maxY; y++) {
      byYear.push({ year: y, count: yearCount.get(y) ?? 0 });
    }
  }

  // Streaks over distinct active days, counted back from the owner's local
  // "today" (see computeStreaks for the day arithmetic). The heatmap needs the
  // same owner-zone anchor for its grid and "future" flags, so the key is
  // returned below rather than left for the client to reconstruct from its
  // own (possibly differently-zoned) clock.
  const todayKey = dayKeyInZone(new Date(), timeZone);
  const { currentStreak, longestStreak } = computeStreaks(
    activity.map((a) => a.date),
    todayKey,
  );

  return {
    total: titles.length,
    movies,
    tv,
    byStatus,
    watchedMovies,
    watchedEpisodes,
    episodesTotal,
    watchTimeMinutes,
    watchTimeEstimatedEpisodes,
    watchTimeEstimatedMovies,
    byLanguage: [...langCount.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count),
    // Zero-fill skipped decades so the chart's spacing is honest (a library
    // with 1970s and 1990s but nothing from the 1980s shows the gap).
    byDecade: (() => {
      const decades = [...decadeCount.keys()].map((d) => parseInt(d, 10));
      if (decades.length === 0) return [];
      const out: { decade: string; count: number }[] = [];
      for (let d = Math.min(...decades); d <= Math.max(...decades); d += 10) {
        out.push({ decade: `${d}s`, count: decadeCount.get(`${d}s`) ?? 0 });
      }
      return out;
    })(),
    byYear,
    byGenre: [...genreCount.entries()]
      .map(([genre, count]) => ({ genre, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
    // One rated title says little about a genre; require two before averaging.
    byGenreRating: [...genreRating.entries()]
      .filter(([, agg]) => agg.count >= 2)
      .map(([genre, agg]) => ({
        genre,
        avg: Math.round((agg.sum / agg.count) * 10) / 10,
        count: agg.count,
      }))
      .sort((a, b) => b.avg - a.avg || b.count - a.count)
      .slice(0, 8),
    // Name tiebreak so ties don't reorder between loads (the query itself has
    // no orderBy) — same pattern as the mostRewatched SQL above.
    topRated: rated
      .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name))
      .slice(0, 8),
    ratedCount: rated.length,
    averageRating,
    ratingDistribution: Array.from({ length: 10 }, (_, i) => ({
      rating: i + 1,
      count: ratingCount[i + 1],
    })),
    // Already one row per active day, ordered oldest-first by the query.
    activity,
    todayKey,
    currentStreak,
    longestStreak,
    activeDays: activity.length,
    totalRewatches,
    mostRewatched,
  };
}
