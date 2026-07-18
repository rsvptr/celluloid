"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
  Check,
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
import { AnimatePresence, motion } from "@/components/motion";
import { addFromTmdb } from "@/lib/actions";
import { setRecommendModel } from "@/lib/settings-actions";
import { REC_ERAS, REC_MODELS, type RecEraId } from "@/lib/models";
import { languageName } from "@/lib/format";
import { cn } from "@/lib/utils";

const CONFIDENCE = {
  high: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
  low: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
} as const;

type Phase = "idle" | "starting" | "thinking" | "generating";

const PHASE_LABEL: Record<Exclude<Phase, "idle">, string> = {
  starting: "Reading your taste brief…",
  thinking: "Thinking about what fits your taste…",
  generating: "Picking titles…",
};

const COUNT_OPTIONS = [6, 12, 20] as const;
const MAX_SEEN_TITLES = 80;

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

export function RecommendClient({
  hasKey,
  model: initialModel,
  tags,
  languages,
  genres,
  hasWatchDates,
}: {
  hasKey: boolean;
  model: string;
  tags: string[];
  languages: string[];
  genres: string[];
  hasWatchDates: boolean;
}) {
  const [countStr, setCountStr] = useState("12");
  const count = Math.min(30, Math.max(1, parseInt(countStr || "12", 10) || 12));
  const [type, setType] = useState<"all" | "movie" | "tv">("all");
  const [focus, setFocus] = useState("");
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [language, setLanguage] = useState("");
  const [genre, setGenre] = useState("");
  const [era, setEra] = useState("");
  const [model, setModel] = useState(initialModel);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  // A single run can emit more than one distinct warning (e.g. a key-fallback
  // notice up front, then a max-tokens partial notice at the end) — keep them
  // all instead of the last one clobbering the rest.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  // Titles shown this session, so "Show different" can ask for fresh ones.
  const seen = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const [basisMode, setBasisMode] = useState<"all" | "recent" | "pick">("all");
  const [recentCount, setRecentCount] = useState(20);
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const pickEmpty = basisMode === "pick" && pickedIds.size === 0;

  // Remember the dial settings for this browsing session so returning to the
  // page keeps your language/genre/era/type choices. Values are validated
  // against what's actually offered; junk or stale entries fall back silently.
  // (Hydrate-from-storage in an effect is the established pattern here; the
  // library toolbar does the same.)
  /* eslint-disable react-hooks/set-state-in-effect */
  const skipFirstWrite = useRef(true);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("celluloid:recprefs");
      if (!raw) return;
      const s = JSON.parse(raw);
      if (typeof s.count === "string" && /^\d{1,2}$/.test(s.count)) setCountStr(s.count);
      if (s.type === "movie" || s.type === "tv" || s.type === "all") setType(s.type);
      if (typeof s.language === "string" && languages.includes(s.language))
        setLanguage(s.language);
      if (typeof s.genre === "string" && genres.includes(s.genre)) setGenre(s.genre);
      if (typeof s.era === "string" && REC_ERAS.some((e) => e.id === s.era))
        setEra(s.era);
      if (s.basisMode === "recent" && hasWatchDates) setBasisMode("recent");
      if ([10, 20, 50].includes(s.recentCount)) setRecentCount(s.recentCount);
    } catch {
      // ignore malformed/unavailable storage
    }
    // Mount-only by design; props are stable for the life of this page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (skipFirstWrite.current) {
      skipFirstWrite.current = false;
      return;
    }
    try {
      sessionStorage.setItem(
        "celluloid:recprefs",
        JSON.stringify({ count: countStr, type, language, genre, era, basisMode, recentCount }),
      );
    } catch {
      // storage may be unavailable; persistence is best-effort
    }
  }, [countStr, type, language, genre, era, basisMode, recentCount]);

  function togglePicked(id: string) {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function changeModel(next: string) {
    setModel(next);
    // Persist as the default; the next request also sends it explicitly.
    setRecommendModel(next).catch(() => {});
  }

  function stop() {
    abortRef.current?.abort();
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
    setLoading(true);
    setPhase("starting");
    setError(null);
    setWarnings([]);
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
      const handle = (ev: RecStreamEvent) => {
        if (ev.type === "status") {
          setPhase(ev.phase);
        } else if (ev.type === "rec") {
          got.push(ev.rec);
          rememberSeenTitle(seen.current, ev.rec.title);
          setRecs([...got]);
        } else if (ev.type === "warning") {
          setWarnings((prev) =>
            prev.includes(ev.message) ? prev : [...prev, ev.message],
          );
        } else if (ev.type === "error") {
          setError(ev.error);
        }
        // "done" needs no special handling: the final ranking happens below
        // whether the stream completed or was stopped early.
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            handle(JSON.parse(line) as RecStreamEvent);
          } catch {
            // skip malformed line
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(recommendationError(e));
    } finally {
      // Ranking runs on whatever arrived — full run, stopped early, or errored
      // partway (partial results stay useful alongside the error message).
      if (abortRef.current === ac) {
        if (got.length > 0) {
          setRecs(rankRecs(got, language || undefined, era as RecEraId | ""));
        }
        setLoading(false);
        setPhase("idle");
      }
    }
  }

  // Bring results into view as soon as the first suggestion streams in (on
  // mobile they sit below the form).
  const hasResults = (recs?.length ?? 0) > 0;
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
                      "focus-ring min-h-11 rounded-full px-3 py-1.5 text-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
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
                      "focus-ring min-h-11 max-w-full min-w-0 break-words rounded-full px-3 py-1.5 text-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
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
                      "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors disabled:opacity-50 sm:min-h-0",
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
                      "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm tabular-nums ring-1 transition-colors disabled:opacity-50 sm:min-h-0",
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

          <details className="rounded-xl bg-surface-2/30 ring-1 ring-line">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
              Tune results
              <span className="text-xs font-normal text-faint">
                Language, genre, era &amp; source titles
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
                          "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
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
                  {[10, 20, 50].map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={recentCount === value}
                      disabled={loading}
                      onClick={() => setRecentCount(value)}
                      className={cn(
                        "focus-ring min-h-11 rounded-full px-3 py-1 text-sm ring-1 transition-colors disabled:opacity-50 sm:min-h-0",
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

          <details className="rounded-xl bg-surface-2/30 ring-1 ring-line">
            <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
              Model &amp; cost
              <span className="text-xs font-normal text-faint">
                {REC_MODELS.find((item) => item.id === model)?.label ?? "Claude"}
              </span>
            </summary>
            <div className="border-t border-line px-3 py-4">
              <label className="flex max-w-md flex-col gap-1">
                <span className="text-xs font-medium text-faint">Claude model</span>
                <Select
                  name="recommendation-model"
                  value={model}
                  disabled={loading}
                  onChange={(event) => changeModel(event.target.value)}
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

      {(loading || (recs && recs.length > 0)) && (
        <div ref={resultsRef} className="flex scroll-mt-20 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            {loading && phase !== "idle" ? (
              <p
                role="status"
                aria-live="polite"
                className="flex items-center gap-2 text-xs text-muted"
              >
                <Spinner className="shrink-0" />
                {PHASE_LABEL[phase]}
                {recs && recs.length > 0 ? (
                  <span className="tabular-nums">
                    {recs.length} of {count} found
                  </span>
                ) : null}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {recs!.length} {recs!.length === 1 ? "suggestion" : "suggestions"}
              </p>
            )}
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

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <AnimatePresence initial={false}>
                {(recs ?? []).map((r) => (
                  <motion.div
                    key={`${r.mediaType}:${r.tmdbId ?? r.title}`}
                    layout
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                    className="min-w-0"
                  >
                    <RecCard rec={r} />
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
          No suggestions came back. Try a different focus or count.
        </p>
      )}
    </div>
  );
}

type AddState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "done"; id: string };

function RecCard({ rec }: { rec: Recommendation }) {
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [, start] = useTransition();

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
            {rec.confidence}
          </span>
        </div>
        <p className="mt-1 text-sm text-foreground/85">{rec.reason}</p>
      </div>
      <div className="shrink-0">
        {rec.tmdbId ? (
          state.kind === "done" ? (
            <Link
              href={`/title/${state.id}`}
              aria-label={`View ${rec.title} in your watchlist`}
              className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 sm:min-h-0"
            >
              <Check size={15} aria-hidden="true" /> Added
            </Link>
          ) : (
            <button
              type="button"
              disabled={state.kind === "adding"}
              aria-label={`Add ${rec.title} to your watchlist`}
              onClick={() =>
                start(async () => {
                  setState({ kind: "adding" });
                  try {
                    const res = await addFromTmdb(rec.tmdbId!, rec.mediaType);
                    if (res.id) {
                      setState({ kind: "done", id: res.id });
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
              }
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
