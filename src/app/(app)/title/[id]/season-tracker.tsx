"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui";
import {
  setAllEpisodesWatched,
  setEpisodeWatched,
  setSeasonWatched,
} from "@/lib/actions";
import { fullDate, progressPct } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface EpisodeVM {
  id: string;
  episodeNumber: number;
  name: string | null;
  airDate: string | null;
  watched: boolean;
}
export interface SeasonVM {
  id: string;
  seasonNumber: number;
  name: string | null;
  episodes: EpisodeVM[];
}

export function SeasonTracker({
  titleId,
  seasons,
}: {
  titleId: string;
  seasons: SeasonVM[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Local optimistic watched-state, keyed by episode id.
  const [watched, setWatched] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {};
    for (const s of seasons) for (const e of s.episodes) m[e.id] = e.watched;
    return m;
  });

  // Re-sync to authoritative server state only when the actual server data
  // changes. The parent rebuilds the `seasons` array on every render, so we key
  // off a content signature (ids + watched flags) — that way an in-flight
  // optimistic tick isn't clobbered by an unrelated parent re-render.
  const serverSig = seasons
    .map((s) => s.episodes.map((e) => `${e.id}:${e.watched ? 1 : 0}`).join(","))
    .join("|");
  useEffect(() => {
    const m: Record<string, boolean> = {};
    for (const s of seasons) for (const e of s.episodes) m[e.id] = e.watched;
    setWatched(m);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSig]);

  const [open, setOpen] = useState<Record<number, boolean>>(() => {
    // Open the first season with an unwatched episode, else the first season.
    const init: Record<number, boolean> = {};
    const firstIncomplete = seasons.find((s) =>
      s.episodes.some((e) => !e.watched),
    );
    const target = firstIncomplete ?? seasons[0];
    if (target) init[target.seasonNumber] = true;
    return init;
  });

  const allEpisodes = useMemo(
    () => seasons.flatMap((s) => s.episodes),
    [seasons],
  );
  const watchedCount = allEpisodes.filter((e) => watched[e.id]).length;
  const total = allEpisodes.length;
  const pct = progressPct(watchedCount, total);
  const allWatched = total > 0 && watchedCount === total;

  function toggleEpisode(epId: string) {
    const next = !watched[epId];
    const prev = watched;
    setWatched((w) => ({ ...w, [epId]: next }));
    startTransition(async () => {
      try {
        await setEpisodeWatched(epId, next);
      } catch {
        setWatched(prev); // roll back optimistic update on failure
      } finally {
        router.refresh();
      }
    });
  }

  function toggleSeason(season: SeasonVM, value: boolean) {
    const prev = watched;
    setWatched((w) => {
      const copy = { ...w };
      for (const e of season.episodes) copy[e.id] = value;
      return copy;
    });
    startTransition(async () => {
      try {
        await setSeasonWatched(season.id, value);
      } catch {
        setWatched(prev);
      } finally {
        router.refresh();
      }
    });
  }

  function toggleAll(value: boolean) {
    const prev = watched;
    setWatched((w) => {
      const copy = { ...w };
      for (const e of allEpisodes) copy[e.id] = value;
      return copy;
    });
    startTransition(async () => {
      try {
        await setAllEpisodesWatched(titleId, value);
      } catch {
        setWatched(prev);
      } finally {
        router.refresh();
      }
    });
  }

  if (total === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Episodes</h2>
          <p className="text-xs text-muted">
            {watchedCount} of {total} watched · {pct}%
          </p>
        </div>
        <Button size="sm" variant={allWatched ? "secondary" : "primary"} aria-pressed={allWatched} onClick={() => toggleAll(!allWatched)}>
          {allWatched ? "Mark all unwatched" : "Mark show watched"}
        </Button>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="brand-gradient h-full transition-all" style={{ width: `${pct}%` }} />
      </div>

      <div className="flex flex-col gap-2">
        {seasons.map((season) => {
          const sWatched = season.episodes.filter((e) => watched[e.id]).length;
          const sTotal = season.episodes.length;
          const sComplete = sTotal > 0 && sWatched === sTotal;
          const isOpen = open[season.seasonNumber] ?? false;
          return (
            <div
              key={season.id}
              className="overflow-hidden rounded-xl bg-surface ring-1 ring-line"
            >
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() =>
                    setOpen((o) => ({
                      ...o,
                      [season.seasonNumber]: !isOpen,
                    }))
                  }
                  aria-expanded={isOpen}
                  className="flex flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                >
                  <ChevronDown
                    size={16}
                    className={cn("text-muted transition-transform", isOpen && "rotate-180")}
                  />
                  <span className="font-medium">
                    {season.name && season.name !== `Season ${season.seasonNumber}`
                      ? season.name
                      : `Season ${season.seasonNumber}`}
                  </span>
                  <span className="text-xs text-muted">
                    {sWatched}/{sTotal}
                  </span>
                </button>
                <button
                  onClick={() => toggleSeason(season, !sComplete)}
                  aria-pressed={sComplete}
                  className={cn(
                    "focus-ring shrink-0 rounded-md px-2 py-1 text-xs ring-1 transition-colors",
                    sComplete
                      ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                      : "bg-surface-2 text-muted ring-line hover:text-foreground",
                  )}
                >
                  {sComplete ? "Watched" : "Mark season"}
                </button>
              </div>

              {isOpen && (
                <ul className="divide-y divide-line border-t border-line">
                  {season.episodes.map((ep) => {
                    const isWatched = watched[ep.id];
                    return (
                      <li key={ep.id}>
                        <button
                          onClick={() => toggleEpisode(ep.id)}
                          aria-pressed={isWatched}
                          className="focus-ring flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/40"
                        >
                          <span
                            className={cn(
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 transition-colors",
                              isWatched
                                ? "brand-gradient ring-transparent"
                                : "bg-surface-2 ring-line",
                            )}
                          >
                            {isWatched && (
                              <Check size={13} className="text-[#04121c]" strokeWidth={3} />
                            )}
                          </span>
                          <span className="w-8 shrink-0 text-xs tabular-nums text-faint">
                            E{ep.episodeNumber}
                          </span>
                          <span
                            className={cn(
                              "min-w-0 flex-1 truncate text-sm",
                              isWatched ? "text-muted" : "text-foreground",
                            )}
                          >
                            {ep.name ?? `Episode ${ep.episodeNumber}`}
                          </span>
                          {ep.airDate && (
                            <span className="hidden shrink-0 text-xs text-faint sm:inline">
                              {fullDate(ep.airDate)}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
