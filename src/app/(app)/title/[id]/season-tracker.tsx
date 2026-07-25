"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronsDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import {
  setAllEpisodesWatched,
  setEpisodeWatched,
  setEpisodesWatchedThrough,
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

function watchedFromServer(seasons: SeasonVM[]): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const s of seasons) for (const e of s.episodes) m[e.id] = e.watched;
  return m;
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
  const [watched, setWatched] = useState<Record<string, boolean>>(() =>
    watchedFromServer(seasons),
  );

  // Re-sync to authoritative server state only when the actual server data
  // changes. The parent rebuilds the `seasons` array on every render, so we key
  // off a content signature (ids + watched flags) — that way an in-flight
  // optimistic tick isn't clobbered by an unrelated parent re-render. Adjusting
  // state during render (guarded by the previous signature) lets React restart
  // the render immediately instead of paint-then-re-render via an effect.
  const serverSig = seasons
    .map((s) => s.episodes.map((e) => `${e.id}:${e.watched ? 1 : 0}`).join(","))
    .join("|");
  const [lastSig, setLastSig] = useState(serverSig);
  if (lastSig !== serverSig) {
    setLastSig(serverSig);
    setWatched(watchedFromServer(seasons));
  }

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

  // The bulk marks deliberately skip episodes that haven't aired, so on an
  // ongoing series "watched everything available" is a distinct state from
  // "watched everything". Naming it "Caught up" stops the button appearing to
  // have failed when it leaves next week's episode unticked.
  // Snapshotted once on mount rather than read during render: reading the clock
  // while rendering is impure (the same render could produce different output),
  // and episodes air on day boundaries, so a value that ages over one page
  // session can't change any answer here.
  const [mountedAt] = useState(() => Date.now());
  const hasAired = (e: EpisodeVM) =>
    e.airDate === null || Date.parse(e.airDate) <= mountedAt;
  const airedEpisodes = allEpisodes.filter(hasAired);
  const caughtUp =
    !allWatched &&
    airedEpisodes.length > 0 &&
    airedEpisodes.every((e) => watched[e.id]);

  function toggleEpisode(epId: string) {
    const next = !watched[epId];
    setWatched((w) => ({ ...w, [epId]: next }));
    startTransition(async () => {
      try {
        await setEpisodeWatched(epId, next);
      } catch {
        // Roll back only this episode, not the whole map — a concurrent
        // successful toggle elsewhere shouldn't be clobbered.
        setWatched((w) => ({ ...w, [epId]: !next }));
      } finally {
        router.refresh();
      }
    });
  }

  function toggleSeason(season: SeasonVM, value: boolean) {
    // Marking reaches only the episodes that have aired, because that is all the
    // server marks. Ticking the whole season optimistically made next week's
    // episode flash watched and then silently untick itself on the refresh below,
    // which reads as a bug rather than as the deliberate aired-only rule. Reuses
    // the same `hasAired` the rest of this component judges by, so the two can't
    // drift apart. Unmarking still clears everything — so does the server.
    const affected = value ? season.episodes.filter(hasAired) : season.episodes;
    const prevValues = new Map(affected.map((e) => [e.id, watched[e.id]]));
    setWatched((w) => {
      const copy = { ...w };
      for (const e of affected) copy[e.id] = value;
      return copy;
    });
    startTransition(async () => {
      try {
        await setSeasonWatched(season.id, value);
      } catch {
        // Roll back only this season's episodes, not the whole map.
        setWatched((w) => {
          const copy = { ...w };
          for (const [id, v] of prevValues) copy[id] = v;
          return copy;
        });
      } finally {
        router.refresh();
      }
    });
  }

  function toggleAll(value: boolean) {
    // Aired-only on the way up, everything on the way down — the same rule
    // toggleSeason follows, and the same one the server enforces.
    const affected = value ? airedEpisodes : allEpisodes;
    const prevValues = new Map(affected.map((e) => [e.id, watched[e.id]]));
    setWatched((w) => {
      const copy = { ...w };
      for (const e of affected) copy[e.id] = value;
      return copy;
    });
    startTransition(async () => {
      try {
        await setAllEpisodesWatched(titleId, value);
      } catch {
        // Roll back only the episodes this action touched, not the whole map.
        setWatched((w) => {
          const copy = { ...w };
          for (const [id, v] of prevValues) copy[id] = v;
          return copy;
        });
      } finally {
        router.refresh();
      }
    });
  }

  // "I'm up to here": marks every aired episode in this season through `ep`.
  function watchThrough(season: SeasonVM, ep: EpisodeVM) {
    const affected = season.episodes.filter(
      (e) => e.episodeNumber <= ep.episodeNumber && !watched[e.id] && hasAired(e),
    );
    if (affected.length === 0) return;
    const prevValues = new Map(affected.map((e) => [e.id, watched[e.id]]));
    setWatched((w) => {
      const copy = { ...w };
      for (const e of affected) copy[e.id] = true;
      return copy;
    });
    startTransition(async () => {
      try {
        const res = await setEpisodesWatchedThrough(ep.id);
        toast.success(
          `Marked ${res.count} ${res.count === 1 ? "episode" : "episodes"} watched`,
        );
      } catch (e) {
        setWatched((w) => {
          const copy = { ...w };
          for (const [id, v] of prevValues) copy[id] = v;
          return copy;
        });
        toast.error((e as Error).message);
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
            {/* "Caught up" is a STATE, so it is reported here rather than on the
                button. Putting it on the button made a destructive control look
                like a status badge: the button is a toggle, so in that state its
                press unwatches the whole show — which is the last thing someone
                tapping the words "Caught up" expects. The button always names
                the action it performs. */}
            {caughtUp && " · caught up on everything aired"}
          </p>
        </div>
        <Button
          size="sm"
          variant={allWatched || caughtUp ? "secondary" : "primary"}
          aria-pressed={allWatched || caughtUp}
          onClick={() => toggleAll(!(allWatched || caughtUp))}
        >
          {allWatched || caughtUp ? "Mark all unwatched" : "Mark show watched"}
        </Button>
      </div>

      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        {/* Animate the fill with a GPU-friendly scaleX (origin-left) and scope the
            transition to transform only — transition-all also animated layout. */}
        <div
          className="brand-gradient h-full w-full origin-left transition-transform"
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, pct / 100))})` }}
        />
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
                  className="flex min-h-11 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 sm:min-h-0"
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
                    "focus-ring flex min-h-11 shrink-0 items-center justify-center rounded-md px-2 py-1 text-xs ring-1 transition-colors sm:min-h-0",
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
                    // Only worth offering when it would do more than a plain
                    // tick — i.e. something earlier in the season is still
                    // unwatched and has aired.
                    const canWatchThrough =
                      !isWatched &&
                      hasAired(ep) &&
                      season.episodes.some(
                        (e) =>
                          e.episodeNumber < ep.episodeNumber &&
                          !watched[e.id] &&
                          hasAired(e),
                      );
                    return (
                      <li key={ep.id} className="flex items-stretch">
                        <button
                          onClick={() => toggleEpisode(ep.id)}
                          aria-pressed={isWatched}
                          // min-h grows the whole row's hit target to >=44px on
                          // touch without inflating the h-5 w-5 checkbox glyph;
                          // sm:min-h-0 restores the original content-driven height.
                          className="focus-ring flex min-h-11 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/40 sm:min-h-0"
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
                        {canWatchThrough && (
                          <button
                            onClick={() => watchThrough(season, ep)}
                            title={`Mark everything watched through episode ${ep.episodeNumber}`}
                            aria-label={`Mark everything watched through episode ${ep.episodeNumber}`}
                            className="focus-ring flex min-h-11 w-11 shrink-0 items-center justify-center text-faint transition-colors hover:bg-surface-2/40 hover:text-foreground sm:min-h-0"
                          >
                            <ChevronsDown size={15} />
                          </button>
                        )}
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
