import Image from "next/image";
import { cookies } from "next/headers";
import { ExternalLink, Play } from "lucide-react";
import { prisma } from "@/lib/prisma";
import {
  getRelatedTitles,
  getVideos,
  getWatchProviders,
  TMDB_IMAGE_BASE,
  type TmdbSearchItem,
  type TmdbVideo,
  type TmdbWatchProviders,
} from "@/lib/tmdb";
import {
  DEFAULT_WATCH_REGION,
  isWatchRegion,
  pickTrailer,
  regionWatchInfo,
} from "@/lib/tmdb-extras";
import { yearOf } from "@/lib/tmdb-match";
import { Card } from "@/components/ui";
import { Poster } from "@/components/poster";
import { MediaType } from "@/generated/prisma/client";
import { QuickAdd, RegionSelect } from "./title-extras-client";

/**
 * Below-the-fold enrichment for a matched title: where to stream it (region
 * aware), a trailer link, and related titles with one-click add. Rendered
 * inside a Suspense boundary so the tracked page never waits on it; any TMDB
 * hiccup degrades to nothing rather than an error page.
 */
export async function TitleExtras({
  userId,
  tmdbId,
  mediaType,
}: {
  userId: string;
  tmdbId: number;
  mediaType: MediaType;
}) {
  const kind = mediaType === MediaType.TV ? ("tv" as const) : ("movie" as const);
  const regionRaw = (await cookies()).get("celluloid-region")?.value;
  const region = isWatchRegion(regionRaw) ? regionRaw : DEFAULT_WATCH_REGION;

  let providers: TmdbWatchProviders | null = null;
  let related: TmdbSearchItem[] = [];
  let videos: TmdbVideo[] = [];
  try {
    // Independent lookups — one round trip's latency, not three.
    [providers, related, videos] = await Promise.all([
      getWatchProviders(kind, tmdbId).catch(() => null),
      getRelatedTitles(kind, tmdbId).catch(() => []),
      getVideos(kind, tmdbId).catch(() => []),
    ]);
  } catch {
    return null;
  }

  const watch = regionWatchInfo(providers?.results, region);
  const trailer = pickTrailer(videos);
  const picks = related.slice(0, 6);

  // Mark related titles already in the library so they deep-link instead of
  // offering a duplicate add.
  const ownedByTmdbId = new Map<number, string>();
  if (picks.length) {
    const owned = await prisma.title.findMany({
      where: {
        userId,
        mediaType,
        tmdbId: { in: picks.map((p) => p.id) },
      },
      select: { id: true, tmdbId: true },
    });
    for (const t of owned) if (t.tmdbId != null) ownedByTmdbId.set(t.tmdbId, t.id);
  }

  if (watch.groups.length === 0 && !trailer && picks.length === 0) return null;

  return (
    <>
      <Card className="p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">Where to watch</h2>
          <div className="flex items-center gap-2">
            {trailer && (
              <a
                href={trailer.url}
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-xs font-medium text-foreground/90 ring-1 ring-line transition-colors hover:text-foreground"
              >
                <Play size={11} aria-hidden /> Watch trailer
              </a>
            )}
            <RegionSelect region={region} />
          </div>
        </div>

        {watch.groups.length === 0 ? (
          <p className="text-sm text-muted">
            No streaming info for this region.
            {watch.link && (
              <>
                {" "}
                <a
                  href={watch.link}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring rounded font-medium text-brand hover:underline"
                >
                  Check JustWatch →
                </a>
              </>
            )}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {watch.groups.map((g) => (
              <div key={g.label} className="flex items-center gap-3">
                <span className="w-12 shrink-0 text-xs font-medium uppercase tracking-wide text-faint">
                  {g.label}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  {g.providers.map((p) => (
                    <span
                      key={p.provider_id}
                      title={p.provider_name}
                      className="flex items-center gap-1.5 rounded-lg bg-surface-2 py-1 pl-1 pr-2.5 text-xs text-foreground/90 ring-1 ring-line"
                    >
                      {p.logo_path ? (
                        <Image
                          src={`${TMDB_IMAGE_BASE}w45${p.logo_path}`}
                          alt=""
                          width={20}
                          height={20}
                          className="rounded-md"
                        />
                      ) : null}
                      {p.provider_name}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-3 text-[11px] text-faint">
          Streaming availability via JustWatch
          {watch.link && (
            <>
              {" · "}
              <a
                href={watch.link}
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex items-center gap-0.5 rounded hover:text-muted"
              >
                open <ExternalLink size={10} aria-hidden />
              </a>
            </>
          )}
        </p>
      </Card>

      {picks.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">More like this</h2>
          <div className="grid grid-cols-3 gap-x-3 gap-y-4 sm:grid-cols-6">
            {picks.map((p) => {
              const name = p.title ?? p.name ?? "Untitled";
              const year = yearOf(p);
              const existingId = ownedByTmdbId.get(p.id);
              return (
                <div key={p.id} className="flex flex-col gap-1.5">
                  <a
                    href={`https://www.themoviedb.org/${kind}/${p.id}`}
                    target="_blank"
                    rel="noreferrer"
                    title={`${name} on TMDB`}
                    className="focus-ring block rounded-lg"
                  >
                    <Poster
                      path={p.poster_path}
                      name={name}
                      mediaType={mediaType}
                      size="w185"
                      sizes="(max-width: 640px) 30vw, 110px"
                      className="ring-1 ring-line transition hover:ring-brand/50"
                    />
                  </a>
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium" title={name}>
                      {name}
                    </p>
                    <p className="text-[11px] text-faint">{year ?? ""}</p>
                  </div>
                  <QuickAdd
                    tmdbId={p.id}
                    mediaType={kind}
                    name={name}
                    existingId={existingId}
                  />
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

/** Skeleton shown while the extras stream in. */
export function TitleExtrasFallback() {
  return (
    <Card className="p-5">
      <div className="shimmer h-4 w-32 rounded bg-surface-2" />
      <div className="mt-4 flex gap-2">
        <div className="shimmer h-7 w-24 rounded-lg bg-surface-2" />
        <div className="shimmer h-7 w-28 rounded-lg bg-surface-2" />
        <div className="shimmer h-7 w-20 rounded-lg bg-surface-2" />
      </div>
    </Card>
  );
}
