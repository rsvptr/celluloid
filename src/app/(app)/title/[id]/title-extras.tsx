import Image from "next/image";
import { cookies } from "next/headers";
import { ExternalLink, Play, UserRound } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getTitleBundle } from "@/lib/tmdb";
import {
  DEFAULT_WATCH_REGION,
  isWatchRegion,
  pickTrailer,
  regionWatchInfo,
} from "@/lib/tmdb-extras";
import { TMDB_IMAGE_BASE } from "@/lib/images";
import { yearOf } from "@/lib/tmdb-match";
import { Badge, Card } from "@/components/ui";
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
  // Region precedence: the per-device cookie (set by the inline picker) beats
  // the account default, which beats the built-in fallback.
  //
  // The saved User.watchRegion used to be written by Settings and never read
  // here, so the account preference did nothing: on any browser without the
  // cookie — a new device, a cleared cache, a private window — you silently got
  // US providers and a US certification regardless of what Settings said.
  // Only fall through to the database when the cookie is absent or invalid, so
  // the common path still costs no extra query.
  const regionRaw = (await cookies()).get("celluloid-region")?.value;
  let region = DEFAULT_WATCH_REGION;
  if (isWatchRegion(regionRaw)) {
    region = regionRaw;
  } else {
    const owner = await prisma.user.findUnique({
      where: { id: userId },
      select: { watchRegion: true },
    });
    const saved = owner?.watchRegion;
    if (isWatchRegion(saved)) region = saved;
  }

  // One append_to_response request carries everything below — down from
  // three separate round trips. The region localizes the certification badge
  // alongside the watch providers it sits next to.
  const bundle = await getTitleBundle(kind, tmdbId, region).catch(() => null);
  if (!bundle) return null;

  const watch = regionWatchInfo(bundle.providersResults, region);
  const trailer = pickTrailer(bundle.videos);
  const picks = bundle.related.slice(0, 6);
  const crewLine = bundle.directors.length
    ? `Directed by ${bundle.directors.join(", ")}`
    : bundle.creators.length
      ? `Created by ${bundle.creators.join(", ")}`
      : null;

  // Mark related titles already in the library so they deep-link instead of
  // offering a duplicate add.
  const ownedByTmdbId = new Map<number, string>();
  if (picks.length) {
    const owned = await prisma.title.findMany({
      where: {
        userId,
        mediaType,
        tmdbId: { in: picks.map((p) => p.id) },
        deletedAt: null,
      },
      select: { id: true, tmdbId: true },
    });
    for (const t of owned) if (t.tmdbId != null) ownedByTmdbId.set(t.tmdbId, t.id);
  }

  if (
    watch.groups.length === 0 &&
    !trailer &&
    picks.length === 0 &&
    !bundle.certification &&
    bundle.topCast.length === 0 &&
    !bundle.imdbUrl
  ) {
    return null;
  }

  return (
    <>
      <Card className="p-5">
        {/* Below sm the actions (trailer/IMDb/region) drop to their own
            full-width line and wrap; sm+ keeps the single justified row. */}
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Where to watch</h2>
            {bundle.certification && (
              <Badge className="bg-surface-2 text-muted ring-line">
                {bundle.certification}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
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
            {bundle.imdbUrl && (
              <a
                href={bundle.imdbUrl}
                target="_blank"
                rel="noreferrer"
                className="focus-ring inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2.5 py-1 text-xs font-medium text-foreground/90 ring-1 ring-line transition-colors hover:text-foreground"
              >
                View on IMDb <ExternalLink size={11} aria-hidden />
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
                  Check JustWatch
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
                Open <ExternalLink size={10} aria-hidden />
              </a>
            </>
          )}
        </p>
      </Card>

      {bundle.topCast.length > 0 && (
        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Cast</h2>
            {crewLine && <p className="text-xs text-faint">{crewLine}</p>}
          </div>
          {/* Below sm: horizontal snap-scroll rail (pure CSS — this is a server
              component). sm+: the multi-column grid. Fixed-width, shrink-0 items
              let the next one peek in as a scroll affordance. */}
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-8 sm:gap-x-3 sm:gap-y-4 sm:overflow-visible sm:pb-0">
            {bundle.topCast.map((c, i) => (
              <div
                key={`${c.name}-${i}`}
                className="flex w-[72px] shrink-0 snap-start flex-col items-center gap-1.5 text-center sm:w-full sm:min-w-0"
              >
                <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line">
                  {c.profilePath ? (
                    <Image
                      src={`${TMDB_IMAGE_BASE}w185${c.profilePath}`}
                      alt={c.name}
                      fill
                      sizes="56px"
                      className="object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center" aria-hidden>
                      <UserRound className="text-faint" size={20} />
                    </div>
                  )}
                </div>
                <div className="w-full min-w-0">
                  <p className="truncate text-[11px] font-medium" title={c.name}>
                    {c.name}
                  </p>
                  {c.character && (
                    <p className="truncate text-[10px] text-faint" title={c.character}>
                      {c.character}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {picks.length > 0 && (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold">More like this</h2>
          {/* Below sm: horizontal snap-scroll rail (pure CSS). Items are a touch
              wider than the cast rail so the poster + Watchlist action sit
              comfortably without overflowing. sm+: the grid. */}
          <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 sm:grid sm:grid-cols-6 sm:gap-x-3 sm:gap-y-4 sm:overflow-visible sm:pb-0">
            {picks.map((p) => {
              const name = p.title ?? p.name ?? "Untitled";
              const year = yearOf(p);
              const existingId = ownedByTmdbId.get(p.id);
              return (
                <div
                  key={p.id}
                  className="flex w-[92px] shrink-0 snap-start flex-col gap-1.5 sm:w-full sm:min-w-0"
                >
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
                      decorative
                      mediaType={mediaType}
                      size="w185"
                      sizes="(max-width: 640px) 92px, 110px"
                      className="ring-1 ring-line transition hover:ring-brand/50"
                    />
                  </a>
                  <div className="w-full min-w-0">
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
