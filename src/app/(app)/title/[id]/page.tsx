import { Suspense } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, CalendarClock, Clock, Globe, Star } from "lucide-react";
import { requireUser } from "@/lib/session";
import { dayKeyInZone, getTags, getTitleDetail, getUserPrefs } from "@/lib/data";
import { prisma } from "@/lib/prisma";
import { WatchEventKind } from "@/generated/prisma/client";
import { Poster } from "@/components/poster";
import { Badge } from "@/components/ui";
import { backdropUrl } from "@/lib/images";
import {
  STATUS_META,
  fullDate,
  languageName,
  mediaTypeLabel,
  runtimeText,
  tvStatusLabel,
} from "@/lib/format";
import { MatchControls } from "@/components/match-controls";
import { TitleControls } from "./title-controls";
import { SeasonTracker } from "./season-tracker";
import { TagEditor } from "./tag-editor";
import { TitleExtras, TitleExtrasFallback } from "./title-extras";
import { WatchHistory } from "./watch-history";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser();
  const title = await getTitleDetail(user.id, id);
  return { title: title?.name ?? "Title" };
}

export default async function TitlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const [title, allTags, watchCount, prefs] = await Promise.all([
    getTitleDetail(user.id, id),
    getTags(user.id),
    // Completion + rewatch count for the "Watched n times" badge and the
    // log-watch toast. Scoped to the owner via WatchEvent.userId (indexed).
    prisma.watchEvent.count({
      where: {
        userId: user.id,
        titleId: id,
        kind: { in: [WatchEventKind.TITLE_COMPLETED, WatchEventKind.REWATCH] },
      },
    }),
    getUserPrefs(user.id),
  ]);
  if (!title) notFound();

  const status = STATUS_META[title.status];
  // w780, not the w1280 default: it sits at 30% under two gradients (TM-13).
  const backdrop = backdropUrl(title.backdropPath, "w780");
  const isTv = title.mediaType === "TV";

  const meta: { icon: typeof Calendar; text: string }[] = [];
  if (title.releaseDate)
    meta.push({ icon: Calendar, text: fullDate(title.releaseDate) });
  if (title.language)
    meta.push({ icon: Globe, text: languageName(title.language) });
  if (title.runtime)
    meta.push({ icon: Clock, text: runtimeText(title.runtime) });
  // TV lifecycle, kept current by the nightly metadata sync
  // (lib/metadata-sync.ts) — null until that has synced this title at least
  // once, and never set for movies.
  if (isTv && title.tmdbStatus) {
    // "Still to come" is judged on the owner's calendar, not the server's UTC
    // one: at 11pm in a zone behind UTC, the server's "today" is already
    // tomorrow, which read an episode airing tonight as already gone. The air
    // date column is a plain calendar date (midnight UTC), so its own day key
    // is taken in UTC and compared with the owner-local day key of now.
    const todayKey = dayKeyInZone(new Date(), prefs?.timeZone ?? "UTC");
    const nextEpisode =
      title.nextEpisodeAirDate &&
      dayKeyInZone(title.nextEpisodeAirDate, "UTC") >= todayKey
        ? `Next episode ${fullDate(title.nextEpisodeAirDate)}`
        : null;
    meta.push({
      icon: CalendarClock,
      text: [tvStatusLabel(title.tmdbStatus), nextEpisode].filter(Boolean).join(" · "),
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <Link
        href="/"
        className="focus-ring inline-flex w-fit items-center gap-1.5 rounded text-sm text-muted hover:text-foreground"
      >
        <ArrowLeft size={15} /> Library
      </Link>

      {/* Hero */}
      <div className="relative overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line">
        {backdrop && (
          <div className="absolute inset-0">
            <Image
              src={backdrop}
              alt=""
              fill
              sizes="(min-width: 1280px) 1280px, 100vw"
              className="scale-105 object-cover opacity-30"
              preload
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/85 to-surface/30" />
            <div className="absolute inset-0 bg-gradient-to-r from-surface/70 to-transparent" />
          </div>
        )}
        <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:p-6">
          <div className="w-32 shrink-0 sm:w-44">
            <Poster
              path={title.posterPath}
              name={title.name}
              decorative
              mediaType={title.mediaType}
              size="w342"
              sizes="(max-width: 640px) 128px, 176px"
              // One preload per page: the backdrop, when there is one, is the
              // larger LCP candidate.
              lcp={backdrop ? "eager" : "preload"}
            />
          </div>
          {/* min-w-0: as a row flex item from sm up, this column would otherwise
              grow to an unbreakable title's width and be clipped (JK-15). */}
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-surface-2 text-muted ring-line">
                {mediaTypeLabel(title.mediaType)}
              </Badge>
              <Badge className={status.badge}>
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </Badge>
              {watchCount >= 2 ? (
                <Badge className="bg-surface-2 text-muted ring-line">
                  Watched {watchCount} times
                </Badge>
              ) : null}
              {title.tmdbRating ? (
                <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                  <Star size={11} className="fill-amber-300" />
                  {title.tmdbRating.toFixed(1)}
                </Badge>
              ) : null}
            </div>

            <h1 className="text-2xl font-bold tracking-tight break-words text-balance sm:text-3xl">
              {title.name}
            </h1>
            {title.originalName && title.originalName !== title.name && (
              <p className="-mt-1 text-sm text-muted">{title.originalName}</p>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
              {meta.map((m, i) => {
                const Icon = m.icon;
                return (
                  <span key={i} className="inline-flex items-center gap-1.5">
                    <Icon size={14} /> {m.text}
                  </span>
                );
              })}
              {isTv && title.totalSeasons ? (
                <span>
                  {title.totalSeasons}{" "}
                  {title.totalSeasons === 1 ? "season" : "seasons"}
                  {title.totalEpisodes ? ` · ${title.totalEpisodes} episodes` : ""}
                </span>
              ) : null}
            </div>

            {title.genres.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {title.genres.map((g) => (
                  <span
                    key={g}
                    className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-muted ring-1 ring-line"
                  >
                    {g}
                  </span>
                ))}
              </div>
            )}

            {title.overview && (
              <p className="max-w-2xl text-sm leading-relaxed text-foreground/90">
                {title.overview}
              </p>
            )}

            <div className="pt-1">
              <MatchControls
                titleId={title.id}
                tmdbId={title.tmdbId}
                mediaType={title.mediaType}
                name={title.name}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Body: tracking + controls, then streamed-in extras. Below lg, `order`
          puts controls first, then the tracker, then history/tags, then extras
          (D-020); at lg the order utilities are dropped and explicit col/row
          start classes reproduce the original layout: tracker spans the first
          two columns, and controls/history/tags are pinned to the third. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:grid-rows-[auto_1fr]">
        <div className="order-1 lg:order-none lg:col-start-3 lg:row-start-1">
          <TitleControls
            id={title.id}
            status={title.status}
            rating={title.rating}
            notes={title.notes}
            favorite={title.favorite}
            watchedAt={title.watchedAt ? title.watchedAt.toISOString() : null}
            watchCount={watchCount}
            timeZone={prefs?.timeZone ?? "UTC"}
          />
        </div>

        {isTv && (
          <div className="order-2 flex flex-col gap-6 lg:order-none lg:col-span-2 lg:col-start-1 lg:row-start-1 lg:row-span-2">
            <SeasonTracker
              titleId={title.id}
              seasons={title.seasons.map((s) => ({
                id: s.id,
                seasonNumber: s.seasonNumber,
                name: s.name,
                episodes: s.episodes.map((e) => ({
                  id: e.id,
                  episodeNumber: e.episodeNumber,
                  name: e.name,
                  airDate: e.airDate ? e.airDate.toISOString() : null,
                  watched: e.watched,
                })),
              }))}
            />
          </div>
        )}

        <aside className="order-3 flex flex-col gap-5 lg:order-none lg:col-start-3 lg:row-start-2 lg:self-start">
          <WatchHistory userId={user.id} titleId={title.id} total={watchCount} timeZone={prefs?.timeZone ?? "UTC"} />
          <TagEditor
            titleId={title.id}
            current={title.tags.map((t) => ({ id: t.tag.id, name: t.tag.name }))}
            all={allTags.map((t) => ({ id: t.id, name: t.name }))}
          />
        </aside>

        {/* Movies have no tracker, so at lg the extras take its rows beside
            the controls instead of leaving columns 1-2 empty (JK-04). */}
        {title.tmdbId != null && (
          <div
            className={`order-4 flex flex-col gap-6 lg:order-none lg:col-span-2 lg:col-start-1 ${
              isTv ? "lg:row-start-3" : "lg:row-start-1 lg:row-span-2"
            }`}
          >
            <Suspense fallback={<TitleExtrasFallback />}>
              <TitleExtras
                userId={user.id}
                tmdbId={title.tmdbId}
                mediaType={title.mediaType}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
}
