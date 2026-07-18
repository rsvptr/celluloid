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
function newEpisodeDiscoveredAfter(now: Date): Date {
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
        tags: { select: { tag: { select: { name: true } } } },
      },
    }),
    // Single extra query (not per-row): every TV title's seasonId->titleId
    // whose episodes have at least one unwatched, already-aired episode
    // discovered inside the fresh window. `some` compiles to a correlated
    // EXISTS against Episode, one join against Title for the owner/status
    // filter — no N+1 across the library grid.
    prisma.season.findMany({
      where: {
        title: { userId, deletedAt: null, mediaType: "TV" as const },
        episodes: {
          some: {
            watched: false,
            airDate: { lte: now },
            discoveredAt: { gt: newEpisodeDiscoveredAfter(now) },
          },
        },
      },
      select: { titleId: true },
      distinct: ["titleId"],
    }),
  ]);
  const newEpisodeTitleIds = new Set(freshTvSeasons.map((s) => s.titleId));

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
    hasNewEpisodes: newEpisodeTitleIds.has(t.id),
  }));
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
 * status. Notes are stripped unless included. getSharePayload's SQL applies the
 * same visibility predicate as an efficiency pre-filter, but this helper is the
 * authoritative gate at the output boundary (defense in depth for a public,
 * no-auth endpoint).
 */
export function shareTitleVisibility(
  config: ShareVisibilityConfig,
  title: { status: WatchStatus; notes: string | null },
): { visible: boolean; notes: string | null } {
  const visible =
    !config.isWholeLibrary ||
    config.includeWatchlist ||
    title.status !== WatchStatus.WATCHLIST;
  return { visible, notes: config.includeNotes ? title.notes : null };
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
        rating: t.rating,
        favorite: t.favorite,
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
  const rows = await prisma.title.findMany({
    where: { userId, deletedAt: null },
    orderBy: [{ mediaType: "asc" }, { name: "asc" }],
    select: {
      id: true,
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
  });

  return rows.map((t) => ({
    id: t.id,
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
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: { episodes: { orderBy: { episodeNumber: "asc" } } },
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
  const hasNewEpisodes =
    title.mediaType === "TV" &&
    title.seasons.some((s) =>
      s.episodes.some(
        (e) =>
          !e.watched &&
          e.airDate !== null &&
          e.airDate <= now &&
          e.discoveredAt > freshAfter,
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
 * Builds a UTC-instant -> owner-local "YYYY-MM-DD" key function for the given
 * IANA time zone, so activity/streaks bucket into the day the owner actually
 * experienced it as, not the server's UTC day. Falls back to UTC if the stored
 * zone is empty or not a valid IANA identifier (Intl throws on construction).
 */
function dayKeyFormatter(timeZone: string): (d: Date) => string {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  return (d: Date) => {
    const parts = fmt.formatToParts(d);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
}

export async function getStats(userId: string): Promise<LibraryStats> {
  const [user, titles, watchEvents] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    }),
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
    // Append-only activity log: drives the heatmap/streaks and rewatch stats.
    // Excludes soft-deleted titles via the relation filter.
    prisma.watchEvent.findMany({
      where: { userId, title: { deletedAt: null } },
      select: {
        kind: true,
        occurredAt: true,
        titleId: true,
        title: { select: { name: true } },
      },
    }),
  ]);
  const dayKey = dayKeyFormatter(user?.timeZone || "UTC");

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
  const dayCount = new Map<string, number>(); // owner-local YYYY-MM-DD -> count

  let movies = 0;
  let tv = 0;
  let watchedMovies = 0;
  let watchedEpisodes = 0;
  let episodesTotal = 0;
  let watchTimeMinutes = 0;
  const rated: { id: string; name: string; rating: number }[] = [];

  for (const t of titles) {
    byStatus[t.status]++;
    if (t.mediaType === "MOVIE") {
      movies++;
      if (t.status === "WATCHED") {
        watchedMovies++;
        watchTimeMinutes += t.runtime ?? 0;
      }
    } else {
      tv++;
      watchedEpisodes += t.watchedEpisodes;
      episodesTotal += t.totalEpisodes ?? 0;
      // ~42 min average if runtime missing
      watchTimeMinutes += t.watchedEpisodes * (t.runtime ?? 42);
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

  // Activity/streaks are driven by the event log (every kind counts), bucketed
  // into the owner's local calendar day. Rewatch stats are tallied from the
  // same pass since REWATCH is one of the event kinds.
  let totalRewatches = 0;
  const rewatchByTitle = new Map<string, { name: string; count: number }>();
  for (const e of watchEvents) {
    const k = dayKey(e.occurredAt);
    dayCount.set(k, (dayCount.get(k) ?? 0) + 1);
    if (e.kind === "REWATCH") {
      totalRewatches++;
      const agg = rewatchByTitle.get(e.titleId) ?? { name: e.title.name, count: 0 };
      agg.count++;
      rewatchByTitle.set(e.titleId, agg);
    }
  }
  const mostRewatched = [...rewatchByTitle.entries()]
    .map(([id, agg]) => ({ id, name: agg.name, count: agg.count }))
    .filter((r) => r.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

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

  // Streaks over distinct active days.
  const activeDayKeys = [...dayCount.keys()].sort();
  let longestStreak = 0;
  let run = 0;
  let prev: number | null = null;
  const DAY = 86_400_000;
  for (const k of activeDayKeys) {
    const t = Date.parse(`${k}T00:00:00Z`);
    run = prev !== null && t - prev === DAY ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = t;
  }
  // Current streak counts back from today (or yesterday), "today" meaning the
  // owner's local calendar day. Once we have a Y-M-D key, stepping by 24h on a
  // UTC-midnight parse of that key always lands on the correct adjacent
  // calendar date (Gregorian day math, independent of the origin time zone).
  const daySet = new Set(activeDayKeys);
  let currentStreak = 0;
  let cursorKey = dayKey(new Date());
  if (!daySet.has(cursorKey)) {
    // allow "yesterday" start
    cursorKey = new Date(Date.parse(`${cursorKey}T00:00:00Z`) - DAY)
      .toISOString()
      .slice(0, 10);
  }
  while (daySet.has(cursorKey)) {
    currentStreak++;
    cursorKey = new Date(Date.parse(`${cursorKey}T00:00:00Z`) - DAY)
      .toISOString()
      .slice(0, 10);
  }

  return {
    total: titles.length,
    movies,
    tv,
    byStatus,
    watchedMovies,
    watchedEpisodes,
    episodesTotal,
    watchTimeMinutes,
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
    topRated: rated.sort((a, b) => b.rating - a.rating).slice(0, 8),
    ratedCount: rated.length,
    averageRating,
    ratingDistribution: Array.from({ length: 10 }, (_, i) => ({
      rating: i + 1,
      count: ratingCount[i + 1],
    })),
    activity: [...dayCount.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    currentStreak,
    longestStreak,
    activeDays: dayCount.size,
    totalRewatches,
    mostRewatched,
  };
}
