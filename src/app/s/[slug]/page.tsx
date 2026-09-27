import type { Metadata } from "next";
import { Clapperboard, LockKeyhole, MessageSquareQuote } from "lucide-react";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { Wordmark } from "@/components/brand";
import { TitleCard } from "@/components/title-card";
import { TmdbAttribution } from "@/components/tmdb-attribution";
import { getSharePayload } from "@/lib/data";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** First `x-forwarded-for` hop, or "unknown" if the request arrived without one. */
function clientIp(headerList: Headers): string {
  const forwardedFor = headerList.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
}

/**
 * IP-keyed cap for this public, no-auth route (getSharePayload has no ceiling
 * of its own). Wrapped in React's cache() — like getSharePayload below — so
 * generateMetadata and the page body, which both run for a single page view,
 * share one deduction instead of two.
 */
const checkShareRateLimit = cache(async () => {
  const ip = clientIp(await headers());
  return rateLimit(`share-page:${ip}`, 60, 60_000);
});

/**
 * Rate-limit-aware wrapper around getSharePayload: a limited caller gets back
 * null, exactly what an unknown slug gets back, so it flows into the same
 * "unavailable" handling as a revoked/expired/missing share below — no
 * separate status code or message that would confirm the slug exists.
 */
async function loadSharePayload(slug: string) {
  const limited = await checkShareRateLimit();
  return limited.ok ? getSharePayload(slug) : null;
}

function itemLabel(count: number) {
  return count === 1 ? "title" : "titles";
}

function movieLabel(count: number) {
  return count === 1 ? "movie" : "movies";
}

function tvLabel(count: number) {
  return count === 1 ? "TV show" : "TV shows";
}

/**
 * Whether a note can overflow its four-line clamp. A card column holds about
 * 22 characters of text-xs per line, so 80 characters or 4 line breaks can;
 * erring long only shows a toggle that changes nothing.
 */
function noteMayClamp(notes: string) {
  return notes.length > 80 || notes.split("\n").length > 4;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const payload = await loadSharePayload(slug);
  const title = payload
    ? payload.name
      ? `${payload.name} · ${payload.ownerName}`
      : `${payload.ownerName}'s list`
    : "Shared list";
  const description = payload
    ? `A read-only list of ${payload.items.length} ${itemLabel(
        payload.items.length,
      )} shared from ${payload.ownerName}'s Celluloid library.`
    : "A shared list from a Celluloid library.";

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    robots: { index: false, follow: false },
  };
}

export default async function SharePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const payload = await loadSharePayload(slug);
  if (!payload) notFound();

  const { items, name, ownerName, includeNotes } = payload;
  const movies = items.filter((item) => item.mediaType === "MOVIE").length;
  const tv = items.length - movies;
  const listTitle = name ?? `${ownerName}'s list`;
  const breakdown = `${movies} ${movieLabel(movies)} · ${tv} ${tvLabel(tv)}`;

  return (
    <div className="relative isolate min-h-dvh overflow-x-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      >
        <div className="absolute left-1/2 top-[-18rem] h-[34rem] w-[58rem] -translate-x-1/2 rounded-full bg-brand-blue/10 blur-[120px]" />
        <div className="absolute -right-40 top-[30rem] h-80 w-80 rounded-full bg-brand-cyan/[0.045] blur-[100px]" />
        <div className="absolute inset-x-0 top-0 h-px brand-gradient opacity-70" />
        <div className="absolute inset-x-0 top-0 h-[34rem] opacity-[0.025] [background-image:linear-gradient(to_right,white_1px,transparent_1px),linear-gradient(to_bottom,white_1px,transparent_1px)] [background-size:56px_56px]" />
      </div>

      <a
        href="#share-content"
        className="focus-ring fixed left-4 top-3 z-50 -translate-y-20 rounded-lg bg-foreground px-4 py-2 text-sm font-semibold text-background transition-transform focus:translate-y-0"
      >
        Skip to shared list
      </a>

      <header className="sticky top-0 z-20 border-b border-line/80 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div>
            <span className="sr-only">Celluloid</span>
            <span aria-hidden="true">
              <Wordmark size={28} href={null} />
            </span>
          </div>
          <div className="flex min-h-9 items-center gap-2 rounded-full border border-line bg-surface/65 px-3 text-xs font-medium text-muted shadow-sm shadow-black/20">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-brand-cyan shadow-[0_0_12px_rgba(45,212,238,0.75)]"
            />
            Shared from Celluloid
          </div>
        </div>
      </header>

      <main
        id="share-content"
        tabIndex={-1}
        className="mx-auto w-full max-w-7xl px-4 sm:px-6 lg:px-8"
      >
        <section className="grid gap-10 border-b border-line/80 py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-end lg:gap-16 lg:py-20">
          <div className="min-w-0">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-brand-cyan">
              Shared list
            </p>
            <h1 className="max-w-4xl break-words text-balance text-4xl font-semibold tracking-[-0.045em] text-foreground sm:text-5xl lg:text-6xl">
              {listTitle}
            </h1>
            <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-3 text-sm text-muted sm:text-base">
              <p>
                Shared by <span className="break-words font-medium text-foreground">{ownerName}</span>
              </p>
              <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-faint sm:block" />
              <p className="inline-flex items-center gap-2">
                <LockKeyhole aria-hidden="true" size={16} />
                Read-only
              </p>
              {includeNotes ? (
                <>
                  <span aria-hidden="true" className="hidden h-1 w-1 rounded-full bg-faint sm:block" />
                  <p className="inline-flex items-center gap-2">
                    <MessageSquareQuote aria-hidden="true" size={16} />
                    Notes included
                  </p>
                </>
              ) : null}
            </div>
          </div>

          <aside
            aria-label="List breakdown"
            className="relative overflow-hidden rounded-[1.4rem] border border-line bg-surface/70 p-5 shadow-[0_24px_80px_-42px_rgba(14,165,233,0.65)] ring-1 ring-white/[0.025] sm:p-6"
          >
            <div aria-hidden="true" className="absolute inset-x-0 top-0 h-px brand-gradient opacity-80" />
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-faint">
              Collection size
            </p>
            <p className="mt-3 flex items-end gap-2">
              <span className="text-5xl font-semibold tracking-[-0.06em] text-foreground tabular-nums">
                {items.length}
              </span>
              <span className="pb-1 text-sm text-muted">{itemLabel(items.length)}</span>
            </p>
            <dl className="mt-6 grid grid-cols-2 border-t border-line pt-4">
              <div>
                <dt className="text-xs text-faint">Movies</dt>
                <dd className="mt-1 text-lg font-medium text-foreground tabular-nums">
                  {movies}
                </dd>
              </div>
              <div className="border-l border-line pl-5">
                <dt className="text-xs text-faint">TV shows</dt>
                <dd className="mt-1 text-lg font-medium text-foreground tabular-nums">
                  {tv}
                </dd>
              </div>
            </dl>
          </aside>
        </section>

        <section id="shared-list" aria-labelledby="shared-list-heading" className="py-10 sm:py-14">
          <div className="mb-7 flex items-end justify-between gap-4 sm:mb-9">
            <div>
              <h2 id="shared-list-heading" className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
                Titles
              </h2>
              <p className="mt-1 text-sm text-muted">{breakdown}</p>
            </div>
            <p className="hidden text-xs font-medium uppercase tracking-[0.16em] text-faint sm:block">
              Read-only collection
            </p>
          </div>

          {items.length === 0 ? (
            <div className="flex min-h-80 flex-col items-center justify-center rounded-[1.4rem] border border-dashed border-line bg-surface/35 px-6 py-16 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line bg-surface-2 text-brand-cyan shadow-lg shadow-black/20">
                <Clapperboard aria-hidden="true" size={24} />
              </span>
              <p className="mt-5 text-base font-semibold text-foreground">No titles here yet</p>
              <p className="mt-2 max-w-sm text-sm leading-6 text-muted">
                This shared list is empty for now.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-3 gap-y-8 min-[480px]:grid-cols-3 sm:grid-cols-4 sm:gap-x-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
              {items.map((item, index) => (
                <article key={item.id} className="min-w-0">
                  <TitleCard
                    item={item}
                    href={null}
                    lcp={index < 2 ? "preload" : index < 7 ? "eager" : undefined}
                  />
                  {includeNotes && item.notes ? (
                    <blockquote className="group/note mt-3 border-l-2 border-brand-cyan/45 pl-3 text-xs leading-5 text-muted">
                      <span className="sr-only">Note from {ownerName}: </span>
                      {/* Anonymous viewers have no detail page, so a clamped
                          note needs its own way to the rest (JK-27). Opening
                          the details lifts the clamp; no client JS. */}
                      <p className="line-clamp-4 break-words whitespace-pre-wrap group-has-[details[open]]/note:line-clamp-none">
                        {item.notes}
                      </p>
                      {noteMayClamp(item.notes) ? (
                        <details className="group/more mt-1">
                          <summary className="focus-ring w-fit cursor-pointer list-none rounded font-medium text-foreground/80 hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <span className="group-open/more:hidden">Show full note</span>
                            <span className="hidden group-open/more:inline">Show less</span>
                          </summary>
                        </details>
                      ) : null}
                    </blockquote>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </section>
      </main>

      <footer className="mx-auto flex w-full max-w-7xl flex-col flex-wrap gap-4 border-t border-line/80 px-4 py-8 text-sm text-faint sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div>
          <span className="sr-only">Celluloid</span>
          <span aria-hidden="true">
            <Wordmark size={22} href={null} textClassName="text-base" />
          </span>
        </div>
        <p className="break-words">A read-only view from {ownerName}&apos;s library.</p>
        {/* Posters and metadata here come from TMDB, and anonymous visitors
            can't reach the Settings "About" credit, so attribute here too. */}
        <TmdbAttribution className="sm:basis-full" />
      </footer>
    </div>
  );
}
