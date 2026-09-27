"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Ban,
  Check,
  ChevronDown,
  Eye,
  Film,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Tv,
} from "lucide-react";
import { toast } from "sonner";
import type { Recommendation, RecStreamEvent } from "@/lib/recommend";
import type { TitleIndexEntry } from "@/lib/data";
import { Button, Card, Input, Select, Spinner } from "@/components/ui";
import { Shimmer } from "@/components/skeleton";
import { Poster } from "@/components/poster";
import { AnimatePresence, EASE_OUT, motion } from "@/components/motion";
import { addFromTmdb } from "@/lib/actions";
import { setRecommendModel } from "@/lib/settings-actions";
import { suppressSuggestion, unsuppressSuggestion } from "@/lib/suppression-actions";
import { SuppressionsPanel } from "./suppressions-panel";
import { REC_ERAS, REC_MODELS, type RecEraId } from "@/lib/models";
import { languageName } from "@/lib/format";
import { undoToast } from "@/lib/undo-toast";
import { cn } from "@/lib/utils";
import {
  encodeRecommendRememberedState,
  REMEMBERED_COOKIE_NAMES,
  type RecommendRememberedState,
  writeRememberedCookie,
} from "@/lib/remembered-state-client";

const CONFIDENCE = {
  high: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  low: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
} as const;

const CONFIDENCE_LABELS: Record<Recommendation["confidence"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

type Phase = "idle" | "starting" | "thinking" | "generating";

/** Why a suggestion was hidden — mirrors SuppressionReason in the Prisma schema. */
type DismissReason = "NOT_INTERESTED" | "SEEN_ELSEWHERE";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  starting: "Reading your taste brief…",
  thinking: "Thinking about what fits your taste…",
  generating: "Picking titles…",
};

const COUNT_OPTIONS = [6, 12, 20] as const;
const MAX_SEEN_TITLES = 80;
const STREAM_STALL_TIMEOUT_MS = 30_000;

class StreamStallError extends Error {
  constructor() {
    super("The recommendation connection stalled. Try again, or ask for fewer titles.");
    this.name = "StreamStallError";
  }
}

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new StreamStallError();
          reject(error);
          controller.abort(error);
        }, STREAM_STALL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function recommendationIdentity(rec: Recommendation): string {
  return rec.tmdbId != null
    ? `${rec.mediaType}:tmdb:${rec.tmdbId}`
    : `${rec.mediaType}:name:${rec.title.trim().toLocaleLowerCase()}:${rec.year ?? "?"}`;
}

function visibleRecommendations(
  recommendations: Recommendation[],
  dismissed: Set<string>,
): Recommendation[] {
  return recommendations.filter((rec) => !dismissed.has(recommendationIdentity(rec)));
}

function rememberSeenTitle(seen: Set<string>, title: string) {
  seen.delete(title);
  seen.add(title);
  if (seen.size <= MAX_SEEN_TITLES) return;

  const oldest = seen.values().next().value;
  if (oldest !== undefined) seen.delete(oldest);
}

function recommendationError(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (error instanceof TypeError || /failed to fetch|network|load failed/i.test(message)) {
    return "Celluloid couldn't reach the recommendation service. Check your connection and retry.";
  }
  return message || "Celluloid couldn't generate recommendations. Check your connection and retry.";
}

/**
 * Final ordering once the stream completes: preference-confirmed picks first
 * (language/era verified via TMDB), then by the model's confidence, keeping
 * stream order as the tiebreak. Mirrors the ranking the batch API used to do.
 */
function rankRecs(
  list: Recommendation[],
  prefLang?: string,
  prefEra?: RecEraId | "",
): Recommendation[] {
  const confRank = { high: 0, medium: 1, low: 2 } as const;
  const range = prefEra ? REC_ERAS.find((e) => e.id === prefEra)?.range : null;
  const prefScore = (r: Recommendation) =>
    (prefLang && r.language === prefLang ? 2 : 0) +
    (range && r.year != null && r.year >= range[0] && r.year <= range[1] ? 1 : 0);
  return list
    .map((r, i) => ({ r, i, s: prefScore(r), c: confRank[r.confidence] ?? 3 }))
    .sort((a, b) => b.s - a.s || a.c - b.c || a.i - b.i)
    .map((x) => x.r);
}

/**
 * Put a dismissed card back at the position it was removed from, so Undo
 * restores the list as it was instead of appending the title to the end. A
 * suggestion that is somehow already back is left alone rather than duplicated.
 */
function restoreAt(
  list: Recommendation[] | null,
  rec: Recommendation,
  index: number,
): Recommendation[] {
  const next = [...(list ?? [])];
  if (next.includes(rec)) return next;
  next.splice(Math.min(index, next.length), 0, rec);
  return next;
}

// Mood presets that pre-fill the focus field (and optionally narrow the type).
const PRESETS: { label: string; focus: string; type?: "movie" | "tv" }[] = [
  { label: "🛋️ Cozy night in", focus: "cozy, low-stakes watches for a relaxed evening" },
  { label: "🤯 Mind-benders", focus: "cerebral, twisty films that mess with reality and reward attention" },
  { label: "💎 Hidden gems", focus: "underseen, critically loved titles that aren't mainstream" },
  { label: "⭐ Like my top-rated", focus: "very close in spirit to the titles I rated highest" },
  { label: "🏆 Critically acclaimed", focus: "award winners with broad critical acclaim" },
  { label: "👻 Spooky", focus: "atmospheric horror and unsettling thrillers" },
  { label: "🎬 Short & light", focus: "short, easy watches", type: "movie" },
];

function resolvePreset(
  key: string | null | undefined,
  tags: string[],
): { key: string; focus: string; type?: "movie" | "tv" } | null {
  if (!key) return null;
  const preset = PRESETS.find((candidate) => candidate.label === key);
  if (preset) return { key, focus: preset.focus, type: preset.type };
  if (!key.startsWith("tag:")) return null;
  const tag = key.slice(4);
  return tags.includes(tag)
    ? { key, focus: `similar to the titles I tagged \"${tag}\"` }
    : null;
}

export function RecommendClient({
  hasKey,
  keySource,
  model: initialModel,
  tags,
  languages,
  genres,
  hasWatchDates,
  initialPreferences,
  rememberFilters,
}: {
  hasKey: boolean;
  keySource: "personal" | "shared" | "none";
  model: string;
  tags: string[];
  languages: string[];
  genres: string[];
  hasWatchDates: boolean;
  initialPreferences: RecommendRememberedState | null;
  rememberFilters: boolean;
}) {
  const initialPreset = resolvePreset(initialPreferences?.preset, tags);
  const initialLanguage =
    initialPreferences && languages.includes(initialPreferences.language)
      ? initialPreferences.language
      : "";
  const initialGenre =
    initialPreferences && genres.includes(initialPreferences.genre)
      ? initialPreferences.genre
      : "";
  const initialEra =
    initialPreferences && REC_ERAS.some((candidate) => candidate.id === initialPreferences.era)
      ? initialPreferences.era
      : "";
  const [countStr, setCountStr] = useState(() =>
    String(initialPreferences?.count ?? 12),
  );
  const count = Math.min(30, Math.max(1, parseInt(countStr || "12", 10) || 12));
  const [type, setType] = useState<"all" | "movie" | "tv">(
    initialPreferences?.type ?? initialPreset?.type ?? "all",
  );
  const [focus, setFocus] = useState(initialPreset?.focus ?? "");
  const [activePreset, setActivePreset] = useState<string | null>(
    initialPreset?.key ?? null,
  );
  const [language, setLanguage] = useState(initialLanguage);
  const [genre, setGenre] = useState(initialGenre);
  const [era, setEra] = useState(initialEra);
  const [model, setModel] = useState(initialModel);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // A single run can emit more than one distinct warning (e.g. a key-fallback
  // notice up front, then a max-tokens partial notice at the end) — keep them
  // all instead of the last one clobbering the rest.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [receivedAny, setReceivedAny] = useState(false);
  // Titles shown this session, so "Show different" can ask for fresh ones.
  const seen = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const dismissedRef = useRef<Set<string>>(new Set());
  const resultsRef = useRef<HTMLDivElement>(null);
  // Bumped whenever the "not interested" list changes, so an open review panel
  // reloads instead of showing a list the owner has already moved on from.
  const [suppressionsKey, setSuppressionsKey] = useState(0);
  const [basisMode, setBasisMode] = useState<"all" | "recent" | "pick">(
    initialPreferences?.basisMode === "recent" && hasWatchDates ? "recent" : "all",
  );
  const [recentCount, setRecentCount] = useState<10 | 20 | 50>(
    initialPreferences?.recentCount ?? 20,
  );
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const pickEmpty = basisMode === "pick" && pickedIds.size === 0;

  useEffect(
    () => () => {
      const active = abortRef.current;
      abortRef.current = null;
      active?.abort();
    },
    [],
  );

  useEffect(() => {
    if (!rememberFilters) return;
    writeRememberedCookie(
      REMEMBERED_COOKIE_NAMES.recommend,
      encodeRecommendRememberedState({
        count,
        type,
        preset: activePreset,
        language,
        genre,
        era,
        // A hand-picked title basis is intentionally transient because the
        // selected title IDs are not part of remembered filter state.
        basisMode: basisMode === "recent" ? "recent" : "all",
        recentCount,
      }),
    );
  }, [activePreset, basisMode, count, era, genre, language, recentCount, rememberFilters, type]);

  function togglePicked(id: string) {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function changeModel(next: string) {
    const previous = model;
    setModel(next);
    // Persist as the default; the next request also sends it explicitly.
    try {
      const res = await setRecommendModel(next);
      if (res.error) {
        setModel(previous);
        toast.error(res.error);
      }
    } catch {
      setModel(previous);
      toast.error("Celluloid couldn't save that model. Check your connection and retry.");
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  /**
   * Turn a suggestion down for good. The in-session `seen` list only stops a
   * title coming back within this page view; this records the refusal so future
   * runs skip it — and skip paying Claude and TMDB to derive it again.
   */
  async function dismiss(rec: Recommendation, index: number, reason: DismissReason) {
    // Remove the card first: the write is fast and the toast carries Undo, so
    // waiting on the round trip would only make the page feel unresponsive.
    const identity = recommendationIdentity(rec);
    dismissedRef.current.add(identity);
    setRecs((current) =>
      (current ?? []).filter((item) => recommendationIdentity(item) !== identity),
    );
    let res: { id?: string; error?: string };
    try {
      res = await suppressSuggestion({
        tmdbId: rec.tmdbId ?? null,
        mediaType: rec.mediaType,
        name: rec.title,
        year: rec.year,
        reason,
      });
    } catch {
      res = {
        error: "Celluloid couldn't hide that suggestion. Check your connection and retry.",
      };
    }
    if (!res.id) {
      // Nothing was recorded, so leaving the card hidden would misrepresent what
      // future runs will do — put it back and say so.
      dismissedRef.current.delete(identity);
      setRecs((current) => restoreAt(current, rec, index));
      toast.error(res.error ?? "Couldn't hide that suggestion. Please try again.");
      return;
    }
    const suppressionId = res.id;
    setSuppressionsKey((value) => value + 1);
    // No confirmation copy: the card coming back is the confirmation.
    undoToast(`${rec.title} won't be suggested again`, {
      undo: async () =>
        (await unsuppressSuggestion(suppressionId)).ok
          ? {}
          : { error: "Couldn't undo that. Restore it under Not interested." },
      failure: "Celluloid couldn't undo that. Check your connection and retry.",
      onSuccess: () => {
        dismissedRef.current.delete(identity);
        setRecs((current) => restoreAt(current, rec, index));
        setSuppressionsKey((value) => value + 1);
      },
    });
  }

  async function generate(over?: {
    focus?: string;
    type?: "all" | "movie" | "tv";
    reset?: boolean;
  }) {
    const useFocus = over?.focus ?? focus;
    const useType = over?.type ?? type;
    // A fresh run (button/preset) starts over; "Show different" keeps excluding.
    if (over?.reset) seen.current = new Set();
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dismissedRef.current = new Set();
    setLoading(true);
    setPhase("starting");
    setError(null);
    setWarnings([]);
    setReceivedAny(false);
    setRecs([]);
    const got: Recommendation[] = [];
    try {
      const res = await fetch("/api/recommend", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          count,
          type: useType,
          focus: useFocus.trim() || undefined,
          model,
          language: language || undefined,
          genre: genre || undefined,
          era: era || undefined,
          basis:
            basisMode === "recent"
              ? { mode: "recent", recentCount }
              : basisMode === "pick"
                ? { mode: "pick", ids: [...pickedIds] }
                : undefined,
          exclude: [...seen.current],
        }),
      });
      if (!res.ok || !res.body) {
        // Pre-stream failures (auth, rate limit) come back as plain JSON.
        const data = await res.json().catch(() => null);
        setError(
          data?.error ??
            (res.status === 429
              ? "You're going a bit fast. Please wait a moment and try again."
              : `Request failed (${res.status}). Please try again.`),
        );
        return;
      }

      // Results stream in as NDJSON — render each suggestion the moment Claude
      // produces it instead of staring at a spinner for the whole batch.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let receivedTerminalEvent = false;
      const handle = (ev: RecStreamEvent) => {
        if (abortRef.current !== ac) return;
        if (ev.type === "status") {
          setPhase(ev.phase);
        } else if (ev.type === "rec") {
          got.push(ev.rec);
          setReceivedAny(true);
          rememberSeenTitle(seen.current, ev.rec.title);
          setRecs(visibleRecommendations(got, dismissedRef.current));
        } else if (ev.type === "warning") {
          setWarnings((prev) =>
            prev.includes(ev.message) ? prev : [...prev, ev.message],
          );
        } else if (ev.type === "error") {
          receivedTerminalEvent = true;
          setError(ev.error);
        } else if (ev.type === "done") {
          receivedTerminalEvent = true;
        }
      };
      const handleLine = (line: string) => {
        if (!line) return;
        try {
          handle(JSON.parse(line) as RecStreamEvent);
        } catch {
          // A malformed complete line is isolated; later NDJSON events can still
          // finish the run. A malformed final tail is caught by the terminal check.
        }
      };
      for (;;) {
        const { done, value } = await readStreamChunk(reader, ac);
        if (done) {
          buf += decoder.decode();
          break;
        }
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          handleLine(line);
        }
      }
      handleLine(buf.trim());
      if (!receivedTerminalEvent && !ac.signal.aborted) {
        setError(
          "This recommendation run was cut short. Anything already suggested is kept; try again for the rest.",
        );
      }
    } catch (e) {
      if (e instanceof StreamStallError) setError(e.message);
      else if ((e as Error).name !== "AbortError") setError(recommendationError(e));
    } finally {
      // Ranking runs on whatever arrived — full run, stopped early, or errored
      // partway (partial results stay useful alongside the error message).
      if (abortRef.current === ac) {
        if (got.length > 0) {
          setRecs(
            rankRecs(
              visibleRecommendations(got, dismissedRef.current),
              language || undefined,
              era as RecEraId | "",
            ),
          );
        }
        setLoading(false);
        setPhase("idle");
      }
    }
  }

  // Bring results into view as soon as the first suggestion streams in (on
  // mobile they sit below the form).
  const recCount = recs?.length ?? 0;
  const hasResults = recCount > 0;
  useEffect(() => {
    if (hasResults) {
      const reducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      resultsRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  }, [hasResults]);

  function applyPreset(key: string, p: { focus: string; type?: "movie" | "tv" }) {
    setActivePreset(key);
    setFocus(p.focus);
    if (p.type) setType(p.type);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span aria-hidden="true" className="text-brand">
            <Sparkles size={20} />
          </span>
          AI recommendations
        </h1>
        <p className="mt-1 text-sm text-muted">
          Claude analyzes your ratings and watchlist to suggest what to watch next.
        </p>
      </div>

      {!hasKey && (
        <Card className="p-4 text-sm text-muted">
          You need an Anthropic API key first.{" "}
          <Link href="/settings" className="focus-ring rounded font-medium text-brand hover:underline">
            Add one in Settings
          </Link>
        </Card>
      )}

      <Card className="p-5">
        <form
          method="post"
          className="flex flex-col gap-5"
          aria-busy={loading}
          onSubmit={(event) => {
            event.preventDefault();
            if (!loading && hasKey && !pickEmpty) void generate({ reset: true });
          }}
        >
          <label htmlFor="recommend-focus" className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">What are you in the mood for?</span>
            <span className="text-xs text-muted">
              Describe the feeling, pace, or titles you want this to resemble.
            </span>
            <Input
              id="recommend-focus"
              name="recommendation-focus"
              value={focus}
              onChange={(event) => {
                setFocus(event.target.value);
                setActivePreset(null);
              }}
              placeholder="Cozy mysteries, slow-burn folk horror, sharp 90s thrillers…"
              autoComplete="off"
              maxLength={280}
            />
          </label>

          <div className="flex flex-col gap-2">
            <span id="recommend-quick-starts" className="text-xs font-medium text-faint">
              Quick starts
            </span>
            <div
              role="group"
              aria-labelledby="recommend-quick-starts"
              className="flex flex-wrap gap-2"
            >
              {PRESETS.map((preset) => {
                const selected = activePreset === preset.label;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    aria-pressed={selected}
                    disabled={loading}
                    onClick={() => applyPreset(preset.label, preset)}
                    className={cn(
                      "focus-ring min-h-11 rounded-full px-3 py-1.5 text-sm ring-1 press disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
                      selected
                        ? "bg-brand/15 text-brand ring-brand/40"
                        : "bg-surface-2 text-foreground/85 ring-line hover:bg-surface-2/70 hover:text-foreground",
                    )}
                  >
                    {preset.label}
                  </button>
                );
              })}
              {tags.slice(0, 6).map((tag) => {
                const key = `tag:${tag}`;
                const selected = activePreset === key;
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={selected}
                    disabled={loading}
                    onClick={() =>
                      applyPreset(key, {
                        focus: `more titles like the ones I tagged "${tag}"`,
                      })
                    }
                    className={cn(
                      "focus-ring min-h-11 max-w-full min-w-0 break-words rounded-full px-3 py-1.5 text-sm ring-1 press disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
                      selected
                        ? "bg-brand/20 text-brand ring-brand/50"
                        : "bg-brand/10 text-brand ring-brand/30 hover:bg-brand/15",
                    )}
                  >
                    #{tag}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-faint">Type</legend>
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    ["all", "Movies & TV"],
                    ["movie", "Movies"],
                    ["tv", "TV"],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={type === value}
                    disabled={loading}
                    onClick={() => setType(value)}
                    className={cn(
                      "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm ring-1 press disabled:opacity-50 sm:min-h-0",
                      type === value
                        ? "bg-brand/15 text-brand ring-brand/40"
                        : "text-muted ring-line hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-xs font-medium text-faint">Number of picks</legend>
              <div className="flex flex-wrap items-center gap-1.5">
                {COUNT_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={count === value}
                    disabled={loading}
                    onClick={() => setCountStr(String(value))}
                    className={cn(
                      "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm tabular-nums ring-1 press disabled:opacity-50 sm:min-h-0",
                      count === value
                        ? "bg-brand/15 text-brand ring-brand/40"
                        : "text-muted ring-line hover:text-foreground",
                    )}
                  >
                    {value}
                  </button>
                ))}
                <label>
                  <span className="sr-only">Custom number of picks</span>
                  <Input
                    name="recommendation-count"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={30}
                    value={countStr}
                    disabled={loading}
                    onChange={(event) => setCountStr(event.target.value)}
                    onBlur={() => setCountStr(String(count))}
                    className="w-20 text-center tabular-nums"
                  />
                </label>
              </div>
            </fieldset>
          </div>

          <details className="group rounded-xl bg-surface-2/30 ring-1 ring-line">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                Tune results
                <span className="text-xs font-normal text-faint">
                  Language, genre, era &amp; source titles
                </span>
              </span>
              <span
                aria-hidden="true"
                className="shrink-0 transition-transform duration-200 group-open:rotate-180"
              >
                <ChevronDown size={16} />
              </span>
            </summary>
            <div className="flex flex-col gap-4 border-t border-line px-3 py-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-xs font-medium text-faint">
                  Base suggestions on
                </legend>
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["all", "Whole library"],
                      ["recent", "Recent watches"],
                      ["pick", "Pick titles"],
                    ] as const
                  ).map(([mode, label]) => {
                    const disabledTab = mode === "recent" && !hasWatchDates;
                    return (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={basisMode === mode}
                        disabled={loading || disabledTab}
                        title={
                          disabledTab
                            ? "Available after you record at least one watch date"
                            : undefined
                        }
                        onClick={() => setBasisMode(mode)}
                        className={cn(
                          "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm ring-1 press disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
                          basisMode === mode
                            ? "bg-brand/15 text-brand ring-brand/40"
                            : "text-muted ring-line hover:text-foreground",
                        )}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>

              {basisMode === "recent" ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  {([10, 20, 50] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={recentCount === value}
                      disabled={loading}
                      onClick={() => setRecentCount(value)}
                      className={cn(
                        "focus-ring min-h-11 rounded-full px-3 py-1 text-sm ring-1 press disabled:opacity-50 sm:min-h-0",
                        recentCount === value
                          ? "bg-brand/15 text-brand ring-brand/40"
                          : "text-muted ring-line hover:text-foreground",
                      )}
                    >
                      Last {value}
                    </button>
                  ))}
                  <span className="text-xs text-faint">
                    Uses titles with a recorded watch date.
                  </span>
                </div>
              ) : null}

              {basisMode === "pick" ? (
                <TitlePicker
                  selected={pickedIds}
                  onToggle={togglePicked}
                  onClear={() => setPickedIds(new Set())}
                />
              ) : null}

              <div className="grid gap-3 sm:grid-cols-3">
                {languages.length > 0 ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-faint">Language</span>
                    <Select
                      name="recommendation-language"
                      value={language}
                      disabled={loading}
                      onChange={(event) => setLanguage(event.target.value)}
                    >
                      <option value="">Any language</option>
                      {languages.map((value) => (
                        <option key={value} value={value}>
                          {languageName(value)}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
                {genres.length > 0 ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-medium text-faint">Genre</span>
                    <Select
                      name="recommendation-genre"
                      value={genre}
                      disabled={loading}
                      onChange={(event) => setGenre(event.target.value)}
                    >
                      <option value="">Any genre</option>
                      {genres.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : null}
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-faint">Era</span>
                  <Select
                    name="recommendation-era"
                    value={era}
                    disabled={loading}
                    onChange={(event) => setEra(event.target.value)}
                  >
                    <option value="">Any era</option>
                    {REC_ERAS.map((value) => (
                      <option key={value.id} value={value.id}>
                        {value.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            </div>
          </details>

          <details className="group rounded-xl bg-surface-2/30 ring-1 ring-line">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
              <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                Model &amp; cost
                <span className="text-xs font-normal text-faint">
                  {REC_MODELS.find((item) => item.id === model)?.label ?? "Claude"}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="shrink-0 transition-transform duration-200 group-open:rotate-180"
              >
                <ChevronDown size={16} />
              </span>
            </summary>
            <div className="border-t border-line px-3 py-4">
              <label className="flex max-w-md flex-col gap-1">
                <span className="text-xs font-medium text-faint">Claude model</span>
                <Select
                  name="recommendation-model"
                  value={model}
                  disabled={loading}
                  onChange={(event) => void changeModel(event.target.value)}
                >
                  {REC_MODELS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label} · {item.note}
                    </option>
                  ))}
                </Select>
              </label>
              <p className="mt-2 text-xs text-muted">
                Larger requests and more capable models generally use more API quota.
              </p>
              <p className="mt-1 text-xs text-muted">
                {keySource === "personal"
                  ? "Using your personal Anthropic key."
                  : keySource === "shared"
                    ? "Using this server's shared Anthropic key."
                    : "No Anthropic key is available."}
              </p>
            </div>
          </details>

          <div className="flex flex-col items-start gap-2">
            <Button
              type="submit"
              variant="primary"
              className="min-h-11"
              disabled={loading || !hasKey || pickEmpty}
            >
              {loading ? <Spinner /> : <Sparkles size={16} aria-hidden="true" />}
              {loading ? "Thinking…" : "Get suggestions"}
            </Button>
            <p className="max-w-2xl text-xs leading-relaxed text-faint">
              Suggestions appear as they&apos;re ready. Opus can take up to a minute to start.
            </p>
            <p className="max-w-2xl text-xs leading-relaxed text-faint">
              Celluloid sends the selected library context to Anthropic to build this
              taste brief: ratings, statuses, tags, and personal notes.
            </p>
          </div>

          {pickEmpty ? (
            <p role="status" className="text-xs text-faint">
              Pick at least one title above, or switch to Whole library.
            </p>
          ) : null}
          {warnings.map((warning) => (
            <div
              key={warning}
              role="status"
              aria-live="polite"
              className="flex items-start justify-between gap-3 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-300 ring-1 ring-amber-500/20"
            >
              <span>{warning}</span>
              <button
                type="button"
                onClick={() =>
                  setWarnings((current) => current.filter((item) => item !== warning))
                }
                aria-label="Dismiss warning"
                className="focus-ring min-h-11 shrink-0 rounded px-2 font-medium text-amber-200/80 hover:text-amber-100 sm:min-h-0"
              >
                Dismiss
              </button>
            </div>
          ))}
          {error ? (
            <p
              role="alert"
              className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20"
            >
              {error}
            </p>
          ) : null}
        </form>
      </Card>

      {(loading || (recs && recs.length > 0) || receivedAny) && (
        <div ref={resultsRef} className="flex scroll-mt-20 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            {/* One live region for the whole run. Swapping it for a plain
                paragraph on completion would tear the node out before the
                announcement could fire, so the run would go silent exactly when
                there was something to say — the same element switches from
                progress to the final count instead. */}
            <p
              role="status"
              aria-live="polite"
              className="flex items-center gap-2 text-xs text-muted"
            >
              {loading && phase !== "idle" ? (
                <>
                  <Spinner className="shrink-0" />
                  {PHASE_LABEL[phase]}
                  {recCount > 0 ? (
                    <span className="tabular-nums">
                      {recCount} of {count} found
                    </span>
                  ) : null}
                </>
              ) : (
                `${recCount} ${recCount === 1 ? "suggestion" : "suggestions"} ready`
              )}
            </p>
            {loading ? (
              <button
                type="button"
                onClick={stop}
                className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-0"
              >
                <Square size={13} aria-hidden="true" />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => generate()}
                disabled={pickEmpty}
                className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
              >
                <RefreshCw size={14} aria-hidden="true" />
                Show different
              </button>
            )}
          </div>

          {/* relative: popLayout positions an exiting card against this grid. */}
          <div className="relative grid grid-cols-1 gap-3 lg:grid-cols-2">
            {/* popLayout takes a dismissed card out of the flow as its exit
                starts, so the others move at once instead of after it (EM-12). */}
            <AnimatePresence initial={false} mode="popLayout">
                {(recs ?? []).map((r, index) => (
                  <motion.div
                    key={recommendationIdentity(r)}
                    // MO-06: measure only when the list changes, not on every
                    // keystroke in the focus box, and move without scaling, so
                    // a card landing in a row of another height isn't squashed.
                    layout="position"
                    layoutDependency={recs}
                    data-motion-enter
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15, ease: EASE_OUT } }}
                    transition={{
                      duration: 0.3,
                      ease: EASE_OUT,
                      layout: { type: "spring", visualDuration: 0.3, bounce: 0 },
                    }}
                    className="min-w-0"
                  >
                    <RecCard
                      rec={r}
                      onDismiss={(reason) => void dismiss(r, index, reason)}
                    />
                  </motion.div>
                ))}
            </AnimatePresence>

            {loading &&
              Array.from({ length: Math.min(2, Math.max(1, count - (recs?.length ?? 0))) }).map(
                (_, i) => (
                  <Card key={`skeleton-${i}`} className="flex min-w-0 items-start gap-3 p-3">
                    <Shimmer className="h-[84px] w-14 shrink-0" />
                    <div className="flex flex-1 flex-col gap-2 py-1">
                      <Shimmer className="h-4 w-2/5" />
                      <Shimmer className="h-3 w-1/4" />
                      <Shimmer className="h-3 w-full" />
                    </div>
                  </Card>
                ),
              )}
          </div>
        </div>
      )}

      {!loading && recs && recs.length === 0 && !error && (
        <p className="py-8 text-center text-sm text-muted">
          {receivedAny
            ? "You've hidden every suggestion from this run. Try Show different for another batch."
            : "No suggestions came back. Try a different focus or count."}
        </p>
      )}

      <SuppressionsPanel refreshKey={suppressionsKey} />
    </div>
  );
}

type AddState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "done"; id: string; existing?: boolean };

function RecCard({
  rec,
  onDismiss,
}: {
  rec: Recommendation;
  onDismiss: (reason: DismissReason) => void;
}) {
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [, start] = useTransition();
  const resultRef = useRef<HTMLAnchorElement>(null);
  const focusResult = useRef(false);

  useEffect(() => {
    if (state.kind === "done" && focusResult.current) {
      focusResult.current = false;
      resultRef.current?.focus();
    }
  }, [state.kind]);

  return (
    <Card className="flex items-start gap-3 p-3">
      <div className="w-14 shrink-0">
        <Poster
          path={rec.posterPath}
          name={rec.title}
          decorative
          mediaType={rec.mediaType === "tv" ? "TV" : "MOVIE"}
          size="w185"
          sizes="56px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{rec.title}</span>
          <span className="text-xs text-muted">
            {rec.mediaType === "tv" ? "TV" : "Movie"}
            {rec.year ? ` · ${rec.year}` : ""}
            {rec.language ? ` · ${languageName(rec.language)}` : ""}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
              CONFIDENCE[rec.confidence],
            )}
          >
            {CONFIDENCE_LABELS[rec.confidence]}
          </span>
        </div>
        <p className="mt-1 text-sm text-foreground/85">{rec.reason}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        {rec.tmdbId ? (
          state.kind === "done" ? (
            <Link
              ref={resultRef}
              href={`/title/${state.id}`}
              aria-label={`View ${rec.title} in your watchlist`}
              className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 sm:min-h-0"
            >
              <Check size={15} aria-hidden="true" /> {state.existing ? "In library" : "Added"}
            </Link>
          ) : (
            <button
              type="button"
              disabled={state.kind === "adding"}
              aria-label={`Add ${rec.title} to your watchlist`}
              onClick={() => {
                focusResult.current = true;
                start(async () => {
                  setState({ kind: "adding" });
                  try {
                    const res = await addFromTmdb(rec.tmdbId!, rec.mediaType);
                    if (res.id) {
                      setState({ kind: "done", id: res.id, existing: res.existing });
                      if (res.restored) {
                        toast.success(
                          "Restored from Trash with your old ratings and notes.",
                        );
                      }
                      return;
                    }
                    setState({ kind: "idle" });
                    toast.error(
                      res.error ?? "Couldn't add that title. Please try again.",
                    );
                  } catch {
                    setState({ kind: "idle" });
                    toast.error(
                      "Celluloid couldn't add that title. Check your connection and retry.",
                    );
                  }
                })
              }}
              className="focus-ring brand-gradient flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-[#04121c] hover:opacity-90 disabled:opacity-60 sm:min-h-0"
            >
              {state.kind === "adding" ? <Spinner /> : <Plus size={15} aria-hidden="true" />}
              Watchlist
            </button>
          )
        ) : (
          <Link
            href={`/add?q=${encodeURIComponent(rec.title)}`}
            aria-label={`Search TMDB for ${rec.title}`}
            title="Not matched automatically. Search TMDB to add it."
            className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-0"
          >
            <Search size={13} aria-hidden="true" /> Find on TMDB
          </Link>
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDismiss("SEEN_ELSEWHERE")}
            aria-label={`Seen ${rec.title} elsewhere`}
            title="Seen it: keep this out of future suggestions"
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-9 sm:min-w-9"
          >
            <Eye size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onDismiss("NOT_INTERESTED")}
            aria-label={`Not interested in ${rec.title}`}
            title="Not interested: keep this out of future suggestions"
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-9 sm:min-w-9"
          >
            <Ban size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    </Card>
  );
}

function TitlePicker({
  selected,
  onToggle,
  onClear,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
  onClear: () => void;
}) {
  const [titles, setTitles] = useState<TitleIndexEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/titles")
      .then((response) => {
        if (!response.ok) throw new Error("title-index-request-failed");
        return response.json();
      })
      .then((d) => {
        if (!cancelled && d?.titles) setTitles(d.titles as TitleIndexEntry[]);
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            "Your library titles could not be loaded. Check your connection and retry.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [retryKey]);

  const filtered = useMemo(() => {
    if (!titles) return [];
    const needle = q.trim().toLowerCase();
    const list = needle
      ? titles.filter((t) => t.name.toLowerCase().includes(needle))
      : titles;
    return list.slice(0, 60);
  }, [titles, q]);

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-surface-2/40 p-2 ring-1 ring-line">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <label htmlFor="recommend-title-search" className="sr-only">
            Search your library titles
          </label>
          <Search
            size={14}
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            id="recommend-title-search"
            name="recommend-title-search"
            type="search"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your titles…"
            className="h-9 pl-8"
          />
        </div>
        <span role="status" aria-live="polite" className="shrink-0 text-xs tabular-nums text-faint">
          {selected.size} selected
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="focus-ring min-h-11 shrink-0 rounded-lg px-2 py-1 text-xs text-muted hover:text-foreground sm:min-h-0"
          >
            Clear
          </button>
        )}
      </div>
      {loadError ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-3 text-center text-xs text-rose-200 ring-1 ring-rose-500/20"
        >
          <p>{loadError}</p>
          <button
            type="button"
            onClick={() => {
              setTitles(null);
              setLoadError(null);
              setRetryKey((value) => value + 1);
            }}
            className="focus-ring min-h-11 rounded-lg px-3 py-1.5 font-medium ring-1 ring-rose-500/30 hover:bg-rose-500/10 sm:min-h-0"
          >
            Retry
          </button>
        </div>
      ) : titles === null ? (
        <p className="px-1 py-3 text-center text-xs text-muted">
          Loading your titles…
        </p>
      ) : filtered.length === 0 ? (
        <p className="px-1 py-3 text-center text-xs text-muted">No titles match.</p>
      ) : (
        <div className="max-h-60 overflow-y-auto overscroll-contain">
          {filtered.map((t) => {
            const on = selected.has(t.id);
            const Icon = t.mediaType === "TV" ? Tv : Film;
            return (
              <button
                key={t.id}
                type="button"
                aria-pressed={on}
                onClick={() => onToggle(t.id)}
                className={cn(
                  "focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors sm:min-h-0",
                  on
                    ? "bg-brand/10 text-foreground"
                    : "text-foreground/85 hover:bg-surface-2/60",
                )}
              >
                <span
                  className={cn(
                    "flex h-4 w-4 shrink-0 items-center justify-center rounded ring-1",
                    on ? "bg-brand text-[#04121c] ring-brand" : "ring-line",
                  )}
                >
                  {on && <Check size={11} aria-hidden="true" />}
                </span>
                <Icon size={14} aria-hidden="true" className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {t.year ? (
                  <span className="shrink-0 text-xs text-faint">{t.year}</span>
                ) : null}
              </button>
            );
          })}
          {q.trim() === "" && titles.length > filtered.length && (
            <p className="px-2 py-1.5 text-center text-[11px] text-faint">
              Showing the first {filtered.length}. Search to find more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
