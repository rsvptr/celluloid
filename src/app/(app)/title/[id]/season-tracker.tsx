"use client";

import { Suspense, use, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, ChevronsDown } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import {
  setAllEpisodesWatched,
  setEpisodeWatched,
  setEpisodesWatchedThrough,
  setSeasonWatched,
} from "@/lib/actions";
import { fullDate, progressPct } from "@/lib/format";
import { episodeLabel, type EpisodeTypeMarker } from "@/lib/tmdb-extras";
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

/** A small premiere or finale label on an episode row. */
function EpisodeTag({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted ring-1 ring-line">
      {label}
    </span>
  );
}

/**
 * The finale label TMDB gives an episode. It waits for the page's TMDB request
 * inside its own Suspense boundary, so the tracker never does.
 */
function FinaleTag({
  seasonNumber,
  episodeNumber,
  episodeTypes,
}: {
  seasonNumber: number;
  episodeNumber: number;
  episodeTypes: Promise<EpisodeTypeMarker[]>;
}) {
  const marker = use(episodeTypes).find(
    (m) => m.seasonNumber === seasonNumber && m.episodeNumber === episodeNumber,
  );
  const label = marker ? episodeLabel(episodeNumber, marker.type) : null;
  return label ? <EpisodeTag label={label} /> : null;
}

async function episodeActionFailure(
  action: () => Promise<{ error?: string }>,
): Promise<string | null> {
  try {
    const result = await action();
    return result.error ?? null;
  } catch {
    return "Couldn't save your episode progress. Try again.";
  }
}

export function SeasonTracker({
  titleId,
  seasons,
  episodeTypes,
}: {
  titleId: string;
  seasons: SeasonVM[];
  /**
   * Finale markers from the page's TMDB request, which describes only the
   * last aired and the next episode. Absent for an unmatched title.
   */
  episodeTypes?: Promise<EpisodeTypeMarker[]>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();

  // Local optimistic watched-state, keyed by episode id.
  const [watched, setWatched] = useState<Record<string, boolean>>(() =>
    watchedFromServer(seasons),
  );
  // Mirrors `watched` so the mutation queue below (see toggleEpisode etc.) can
  // diff against the true current value — including edits from clicks that
  // happened after an earlier job was already queued — rather than a value
  // closed over when that job was created. `applyWatched` keeps it current
  // synchronously on every optimistic edit (it only ever runs from an event
  // handler, never during render, so writing a ref there is fine). Refs may
  // only be written outside render, though — never inline in the component
  // body the way the resync block below writes `watched` — so a plain effect
  // covers that path instead, and this can't be folded into the block above.
  const latestWatchedRef = useRef(watched);
  useEffect(() => {
    latestWatchedRef.current = watched;
  }, [watched]);

  /** Patches `watched` (and its ref mirror) with `{episodeId: nextValue}` pairs. */
  function applyWatched(patch: Record<string, boolean>) {
    const next = { ...latestWatchedRef.current, ...patch };
    latestWatchedRef.current = next;
    setWatched(next);
  }

  // Re-sync to authoritative server state only when the actual server data
  // changes. The parent rebuilds the `seasons` array on every render, so we key
  // off a content signature (ids + watched flags) — that way an in-flight
  // optimistic tick isn't clobbered by an unrelated parent re-render. Adjusting
  // state during render (guarded by the previous signature) lets React restart
  // the render immediately instead of paint-then-re-render via an effect. Also
  // skips while the mutation queue below is draining — lastSig is left
  // untouched so the change is re-detected once the queue settles — otherwise a
  // resync mid-batch could overwrite an optimistic tick for an episode later in
  // the same batch with stale pre-batch server data.
  const serverSig = seasons
    .map((s) => s.episodes.map((e) => `${e.id}:${e.watched ? 1 : 0}`).join(","))
    .join("|");
  const [lastSig, setLastSig] = useState(serverSig);
  if (lastSig !== serverSig && !isPending) {
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

  // Serialized drain queue for the four handlers below (see title-controls.tsx's
  // immediate-field queue for the pattern this mirrors — read that first). Each
  // handler used to open its own startTransition and call router.refresh() in
  // its own finally, so ticking several episodes quickly fired one full-page
  // RSC re-fetch PER CLICK — N sequential server round-trips behind an already
  // -instant optimistic UI. Now every click still applies its optimistic change
  // synchronously via applyWatched (outside the transition, so it never waits
  // its turn), but the network call it triggers is only queued; drainQueue
  // drains one call at a time — never more than one in flight. Each successful
  // call returns the re-rendered page, so router.refresh() fires only after a
  // failure, once the queue is empty. Each queued job captures its own rollback
  // (which episodes, and what to revert them to) and only applies it if
  // nothing newer has since touched
  // those same episodes — see the per-job supersession check in each handler —
  // so a slow failure can never clobber a later, already-settled change.
  const queueRef = useRef<Array<() => Promise<void>>>([]);
  const drainingRef = useRef(false);
  const queueErrorRef = useRef<string | null>(null);

  async function drainQueue() {
    if (drainingRef.current) return; // a drain is already running
    drainingRef.current = true;
    try {
      while (queueRef.current.length > 0) {
        const job = queueRef.current.shift()!;
        await job();
      }
    } finally {
      drainingRef.current = false;
    }
    const error = queueErrorRef.current;
    queueErrorRef.current = null;
    if (error) {
      toast.error(error);
      router.refresh();
    }
  }

  // Kick the drain inside a transition so isPending stays true for its whole
  // run — the resync guard above keys off isPending to avoid clobbering an
  // in-flight batch. If a drain is already running it simply absorbs the new
  // job on its next loop iteration.
  function enqueue(job: () => Promise<void>) {
    queueRef.current.push(job);
    if (drainingRef.current) return;
    startTransition(async () => {
      await drainQueue();
    });
  }

  function toggleEpisode(epId: string) {
    const prev = latestWatchedRef.current[epId];
    const next = !prev;
    applyWatched({ [epId]: next });
    enqueue(async () => {
      const error = await episodeActionFailure(() => setEpisodeWatched(epId, next));
      if (error) {
        // Roll back only if nothing newer has touched this episode since — a
        // concurrent successful toggle elsewhere shouldn't be clobbered.
        if (latestWatchedRef.current[epId] === next) {
          applyWatched({ [epId]: prev });
        }
        queueErrorRef.current ??= error;
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
    const prevValues = new Map(
      affected.map((e) => [e.id, latestWatchedRef.current[e.id]]),
    );
    applyWatched(Object.fromEntries(affected.map((e) => [e.id, value])));
    enqueue(async () => {
      const error = await episodeActionFailure(() => setSeasonWatched(season.id, value));
      if (error) {
        // Roll back only episodes still holding the value this call set, not
        // the whole map — anything a later click already changed again is left
        // dirty rather than clobbered (that click's own job owns it now).
        const toRevert: Record<string, boolean> = {};
        for (const [id, prevValue] of prevValues) {
          if (latestWatchedRef.current[id] === value) toRevert[id] = prevValue;
        }
        if (Object.keys(toRevert).length > 0) applyWatched(toRevert);
        queueErrorRef.current ??= error;
      }
    });
  }

  function toggleAll(value: boolean) {
    // Aired-only on the way up, everything on the way down — the same rule
    // toggleSeason follows, and the same one the server enforces.
    const affected = value ? airedEpisodes : allEpisodes;
    const prevValues = new Map(
      affected.map((e) => [e.id, latestWatchedRef.current[e.id]]),
    );
    applyWatched(Object.fromEntries(affected.map((e) => [e.id, value])));
    enqueue(async () => {
      const error = await episodeActionFailure(() =>
        setAllEpisodesWatched(titleId, value),
      );
      if (error) {
        // Roll back only the episodes this action touched AND that still hold
        // the value it set — not the whole map, and not anything re-edited since.
        const toRevert: Record<string, boolean> = {};
        for (const [id, prevValue] of prevValues) {
          if (latestWatchedRef.current[id] === value) toRevert[id] = prevValue;
        }
        if (Object.keys(toRevert).length > 0) applyWatched(toRevert);
        queueErrorRef.current ??= error;
      }
    });
  }

  async function confirmMassUnwatch(episodes: EpisodeVM[], scope: string) {
    const count = episodes.filter((episode) => latestWatchedRef.current[episode.id]).length;
    // A one-off correction should stay lightweight. The destructive case is a
    // mass clear, where a sparse hand-curated pattern cannot be reconstructed by
    // the available "mark watched" bulk action.
    if (count <= 3) return true;
    return confirm({
      title: `Mark ${count} episodes unwatched?`,
      body: `Unlike unticking one episode, this clears these ticks but keeps their watch activity history. The individual pattern ${scope} can't be restored automatically.`,
      confirmLabel: "Mark unwatched",
      destructive: true,
    });
  }

  async function requestSeasonToggle(season: SeasonVM, value: boolean) {
    if (
      !value &&
      !(await confirmMassUnwatch(
        season.episodes,
        `in ${season.name ?? `Season ${season.seasonNumber}`}`,
      ))
    ) {
      return;
    }
    toggleSeason(season, value);
  }

  async function requestAllToggle(value: boolean) {
    if (!value && !(await confirmMassUnwatch(allEpisodes, "across this show"))) return;
    toggleAll(value);
  }

  // "I'm up to here": marks every aired episode in this season through `ep`.
  function watchThrough(season: SeasonVM, ep: EpisodeVM) {
    const affected = season.episodes.filter(
      (e) =>
        e.episodeNumber <= ep.episodeNumber &&
        !latestWatchedRef.current[e.id] &&
        hasAired(e),
    );
    if (affected.length === 0) return;
    const prevValues = new Map(
      affected.map((e) => [e.id, latestWatchedRef.current[e.id]]),
    );
    applyWatched(Object.fromEntries(affected.map((e) => [e.id, true])));
    enqueue(async () => {
      try {
        const res = await setEpisodesWatchedThrough(ep.id);
        if (res.error) {
          const toRevert: Record<string, boolean> = {};
          for (const [id, prevValue] of prevValues) {
            if (latestWatchedRef.current[id] === true) toRevert[id] = prevValue;
          }
          if (Object.keys(toRevert).length > 0) applyWatched(toRevert);
          queueErrorRef.current ??= res.error;
          return;
        }
        const changed = res.count ?? 0;
        toast.success(
          `Marked ${changed} ${changed === 1 ? "episode" : "episodes"} watched`,
        );
      } catch {
        const toRevert: Record<string, boolean> = {};
        for (const [id, prevValue] of prevValues) {
          if (latestWatchedRef.current[id] === true) toRevert[id] = prevValue;
        }
        if (Object.keys(toRevert).length > 0) applyWatched(toRevert);
        queueErrorRef.current ??= "Couldn't save your episode progress. Try again.";
      }
    });
  }

  if (total === 0) return null;

  return (
    <>
      {dialog}
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
                the action it performs, so it is an action button with no
                aria-pressed: "Mark all unwatched, pressed" contradicted
                itself (APG button pattern, JK-06). */}
            {caughtUp && " · caught up on everything aired"}
          </p>
        </div>
        <Button
          size="sm"
          variant={allWatched || caughtUp ? "secondary" : "primary"}
          onClick={() => void requestAllToggle(!(allWatched || caughtUp))}
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
                {/* A season TMDB lists with no episodes yet has nothing to
                    expand or mark: say so, and offer neither (JK-31). */}
                <button
                  onClick={() =>
                    setOpen((o) => ({
                      ...o,
                      [season.seasonNumber]: !isOpen,
                    }))
                  }
                  disabled={sTotal === 0}
                  aria-expanded={sTotal > 0 ? isOpen : undefined}
                  className="flex min-h-11 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 sm:min-h-0"
                >
                  <ChevronDown
                    size={16}
                    className={cn(
                      "text-muted transition-transform",
                      isOpen && "rotate-180",
                      sTotal === 0 && "invisible",
                    )}
                  />
                  <span className="font-medium">
                    {season.name && season.name !== `Season ${season.seasonNumber}`
                      ? season.name
                      : `Season ${season.seasonNumber}`}
                  </span>
                  <span className="text-xs text-muted">
                    {sTotal === 0 ? "No episodes announced yet" : `${sWatched}/${sTotal}`}
                  </span>
                </button>
                {sTotal > 0 && (
                  <button
                    onClick={() => void requestSeasonToggle(season, !sComplete)}
                    className={cn(
                      "focus-ring flex min-h-11 shrink-0 items-center justify-center rounded-md px-2 py-1 text-xs ring-1 press sm:min-h-0",
                      sComplete
                        ? "bg-status-watched-subtle text-status-watched-text ring-status-watched-border"
                        : "bg-surface-2 text-muted ring-line hover:text-foreground",
                    )}
                  >
                    {sComplete ? "Mark season unwatched" : "Mark season watched"}
                  </button>
                )}
              </div>

              {isOpen && sTotal > 0 && (
                <ul className="divide-y divide-line border-t border-line">
                  {season.episodes.map((ep) => {
                    const isWatched = watched[ep.id];
                    // Only worth offering when it would do more than a plain
                    // tick — i.e. something earlier in the season is still
                    // unwatched and has aired.
                    const premiere = episodeLabel(ep.episodeNumber, null);
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
                          className="focus-ring focus-ring-inset flex min-h-11 flex-1 items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/40 active:bg-surface-2/60 sm:min-h-0"
                        >
                          <span
                            className={cn(
                              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md ring-1 transition-colors",
                              isWatched
                                ? "brand-gradient ring-transparent"
                                : "bg-surface-2 ring-line-strong",
                            )}
                          >
                            {isWatched && (
                              <Check size={13} className="text-on-accent" strokeWidth={3} />
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
                            title={ep.name ?? undefined}
                          >
                            {ep.name ?? `Episode ${ep.episodeNumber}`}
                          </span>
                          {premiere ? (
                            <EpisodeTag label={premiere} />
                          ) : episodeTypes ? (
                            <Suspense fallback={null}>
                              <FinaleTag
                                seasonNumber={season.seasonNumber}
                                episodeNumber={ep.episodeNumber}
                                episodeTypes={episodeTypes}
                              />
                            </Suspense>
                          ) : null}
                          {ep.airDate && (
                            <span className="hidden shrink-0 text-xs text-faint sm:inline">
                              {fullDate(ep.airDate)}
                            </span>
                          )}
                        </button>
                        {canWatchThrough ? (
                          <button
                            onClick={() => watchThrough(season, ep)}
                            title={`Mark everything watched through episode ${ep.episodeNumber}`}
                            aria-label={`Mark everything watched through episode ${ep.episodeNumber}`}
                            className="focus-ring focus-ring-inset flex min-h-11 w-11 shrink-0 items-center justify-center text-faint transition-colors hover:bg-surface-2/40 hover:text-foreground sm:min-h-0"
                          >
                            <ChevronsDown size={16} />
                          </button>
                        ) : (
                          // Hold the button's slot where the date column shows,
                          // so the dates line up whether or not a row has one
                          // (JK-36).
                          <span aria-hidden="true" className="hidden w-11 shrink-0 sm:block" />
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
    </>
  );
}
