import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Calendar, Clock, Globe, Star } from "lucide-react";
import { requireUser } from "@/lib/session";
import { getTags, getTitleDetail } from "@/lib/data";
import { Poster } from "@/components/poster";
import { Badge } from "@/components/ui";
import { backdropUrl } from "@/lib/images";
import {
  STATUS_META,
  fullDate,
  languageName,
  mediaTypeLabel,
  runtimeText,
} from "@/lib/format";
import { FadeIn } from "@/components/motion";
import { MatchControls } from "@/components/match-controls";
import { TitleControls } from "./title-controls";
import { SeasonTracker } from "./season-tracker";
import { TagEditor } from "./tag-editor";

export default async function TitlePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();
  const [title, allTags] = await Promise.all([
    getTitleDetail(user.id, id),
    getTags(user.id),
  ]);
  if (!title) notFound();

  const status = STATUS_META[title.status];
  const backdrop = backdropUrl(title.backdropPath);
  const isTv = title.mediaType === "TV";

  const meta: { icon: typeof Calendar; text: string }[] = [];
  if (title.releaseDate)
    meta.push({ icon: Calendar, text: fullDate(title.releaseDate) });
  if (title.language)
    meta.push({ icon: Globe, text: languageName(title.language) });
  if (title.runtime)
    meta.push({ icon: Clock, text: runtimeText(title.runtime) });

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
              sizes="100vw"
              className="scale-105 object-cover opacity-30"
              priority
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface via-surface/85 to-surface/30" />
            <div className="absolute inset-0 bg-gradient-to-r from-surface/70 to-transparent" />
          </div>
        )}
        <div className="relative flex flex-col gap-5 p-5 sm:flex-row sm:p-6">
          <FadeIn className="w-32 shrink-0 sm:w-44" y={12}>
            <Poster
              path={title.posterPath}
              name={title.name}
              mediaType={title.mediaType}
              size="w500"
              sizes="(max-width: 640px) 128px, 176px"
              priority
            />
          </FadeIn>
          <FadeIn className="flex flex-col gap-3" delay={0.08}>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-surface-2 text-muted ring-line">
                {mediaTypeLabel(title.mediaType)}
              </Badge>
              <Badge className={status.badge}>
                <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
                {status.label}
              </Badge>
              {title.tmdbRating ? (
                <Badge className="bg-amber-500/15 text-amber-300 ring-amber-500/30">
                  <Star size={11} className="fill-amber-300" />
                  {title.tmdbRating.toFixed(1)}
                </Badge>
              ) : null}
            </div>

            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
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
          </FadeIn>
        </div>
      </div>

      {/* Body: tracking + controls */}
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-6 lg:col-span-2">
          {isTv ? (
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
          ) : (
            <div className="hidden rounded-[var(--radius-card)] border border-dashed border-line p-6 text-sm text-muted lg:block">
              Mark this movie&apos;s status and rating on the right.
            </div>
          )}
        </div>

        <aside className="flex flex-col gap-5">
          <TitleControls
            id={title.id}
            status={title.status}
            rating={title.rating}
            notes={title.notes}
            favorite={title.favorite}
            watchedAt={title.watchedAt ? title.watchedAt.toISOString() : null}
          />
          <TagEditor
            titleId={title.id}
            current={title.tags.map((t) => ({ id: t.tag.id, name: t.tag.name }))}
            all={allTags.map((t) => ({ id: t.id, name: t.name }))}
          />
        </aside>
      </div>
    </div>
  );
}
