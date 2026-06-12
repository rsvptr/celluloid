import { prisma } from "@/lib/prisma";
import type { MediaType, WatchStatus } from "@/generated/prisma/client";
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
}

export async function getLibraryItems(userId: string): Promise<LibraryItem[]> {
  const rows = await prisma.title.findMany({
    where: { userId },
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
  });

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
    where: { userId },
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
      createdAt: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    count: r.titleIds.length > 0 ? r.titleIds.length : null,
    includeNotes: r.includeNotes,
    createdAt: r.createdAt.toISOString(),
  }));
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

/** Public (no-auth) resolver for /s/[slug]. Returns null if the link is unknown. */
export async function getSharePayload(slug: string): Promise<SharePayload | null> {
  const share = await prisma.shareList.findUnique({
    where: { slug },
    select: {
      userId: true,
      name: true,
      titleIds: true,
      includeNotes: true,
      includeWatchlist: true,
    },
  });
  if (!share) return null;

  const owner = await prisma.user.findUnique({
    where: { id: share.userId },
    select: { name: true },
  });

  // Explicit selections are shown exactly as picked. Whole-library shares hide
  // not-yet-watched WATCHLIST titles unless the owner opted to include them.
  const isWholeLibrary = share.titleIds.length === 0;
  const titles = await prisma.title.findMany({
    where: {
      userId: share.userId,
      ...(isWholeLibrary ? {} : { id: { in: share.titleIds } }),
      ...(isWholeLibrary && !share.includeWatchlist
        ? { status: { not: "WATCHLIST" } }
        : {}),
    },
    orderBy: [{ favorite: "desc" }, { name: "asc" }],
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

  return {
    name: share.name,
    ownerName: owner?.name ?? "Someone",
    includeNotes: share.includeNotes,
    items: titles.map((t) => ({
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
      notes: share.includeNotes ? t.notes : null,
    })),
  };
}

export async function getExportRows(userId: string): Promise<ExportRow[]> {
  const rows = await prisma.title.findMany({
    where: { userId },
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

export async function getTitleDetail(userId: string, id: string) {
  return prisma.title.findFirst({
    where: { id, userId },
    include: {
      seasons: {
        orderBy: { seasonNumber: "asc" },
        include: { episodes: { orderBy: { episodeNumber: "asc" } } },
      },
      tags: { include: { tag: true } },
    },
  });
}

export type TitleDetail = NonNullable<Awaited<ReturnType<typeof getTitleDetail>>>;

export async function getTags(userId: string) {
  return prisma.tag.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: { _count: { select: { titles: true } } },
  });
}

export async function getDistinctLanguages(userId: string): Promise<string[]> {
  const rows = await prisma.title.findMany({
    where: { userId, language: { not: null } },
    distinct: ["language"],
    select: { language: true },
  });
  return rows.map((r) => r.language!).filter(Boolean).sort();
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
    where: { userId },
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
  // Watch activity (from watchedAt timestamps; sparse until tracked in-app)
  activity: { date: string; count: number }[]; // YYYY-MM-DD
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
  // Completion
  episodesTotal: number;
}

export async function getStats(userId: string): Promise<LibraryStats> {
  const [titles, episodeDates] = await Promise.all([
    prisma.title.findMany({
      where: { userId },
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
        watchedAt: true,
        genres: true,
      },
    }),
    prisma.episode.findMany({
      where: {
        season: { title: { userId } },
        watched: true,
        watchedAt: { not: null },
      },
      select: { watchedAt: true },
    }),
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
  const ratingCount = new Array<number>(11).fill(0); // index = rating (1..10)
  const dayCount = new Map<string, number>(); // YYYY-MM-DD -> count

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const bump = (d: Date | null) => {
    if (d) dayCount.set(dayKey(d), (dayCount.get(dayKey(d)) ?? 0) + 1);
  };

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
        bump(t.watchedAt);
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
    }
  }

  for (const e of episodeDates) bump(e.watchedAt);

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
  // Current streak counts back from today (or yesterday).
  const daySet = new Set(activeDayKeys);
  let currentStreak = 0;
  const cursor = new Date();
  cursor.setUTCHours(0, 0, 0, 0);
  if (!daySet.has(dayKey(cursor))) cursor.setTime(cursor.getTime() - DAY); // allow "yesterday" start
  while (daySet.has(dayKey(cursor))) {
    currentStreak++;
    cursor.setTime(cursor.getTime() - DAY);
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
  };
}
