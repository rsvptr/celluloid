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
import { AnimatePresence, motion, MotionProvider } from "@/components/motion";
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
  generating: "Curating picks…",
};

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
  { label: "🛋️ Cozy night in", focus: "cozy, comforting, low-stakes watches for a relaxed evening" },
  { label: "🤯 Mind-benders", focus: "cerebral, twisty films that mess with reality and reward attention" },
  { label: "💎 Hidden gems", focus: "underseen, critically loved titles that aren't mainstream" },
  { label: "⭐ Like my top-rated", focus: "very close in spirit to the titles I rated highest" },
  { label: "🏆 Critically acclaimed", focus: "award-winning, widely acclaimed essential viewing" },
  { label: "👻 Spooky", focus: "atmospheric horror and unsettling thrillers" },
  { label: "🎬 Short & light", focus: "shorter, easy, feel-good picks", type: "movie" },
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
  const [language, setLanguage] = useState("");
  const [genre, setGenre] = useState("");
  const [era, setEra] = useState("");
  const [model, setModel] = useState(initialModel);
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
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
          seen.current.add(ev.rec.title);
          setRecs([...got]);
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
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      // Ranking runs on whatever arrived — full run, stopped early, or errored
      // partway (partial results stay useful alongside the error message).
      if (got.length > 0) setRecs(rankRecs(got, language || undefined, era as RecEraId | ""));
      if (abortRef.current === ac) {
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
      resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [hasResults]);

  function applyPreset(p: { focus: string; type?: "movie" | "tv" }) {
    setFocus(p.focus);
    if (p.type) setType(p.type);
    if (hasKey && !loading) generate({ focus: p.focus, type: p.type ?? type, reset: true });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
          <span className="text-brand">
            <Sparkles size={20} />
          </span>
          AI recommendations
        </h1>
        <p className="mt-1 text-sm text-muted">
          Claude analyzes your ratings and watchlist to suggest what to watch next.
        </p>
      </div>

      {/* Mood / tag presets */}
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            disabled={!hasKey || loading || pickEmpty}
            onClick={() => applyPreset(p)}
            className="focus-ring rounded-full bg-surface-2 px-3 py-1.5 text-sm text-foreground/85 ring-1 ring-line transition-colors hover:bg-surface-2/70 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {p.label}
          </button>
        ))}
        {tags.slice(0, 6).map((t) => (
          <button
            key={`tag-${t}`}
            type="button"
            disabled={!hasKey || loading || pickEmpty}
            onClick={() =>
              applyPreset({ focus: `more titles like the ones I tagged "${t}"` })
            }
            className="focus-ring rounded-full bg-brand/10 px-3 py-1.5 text-sm text-brand ring-1 ring-brand/30 transition-colors hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
          >
            #{t}
          </button>
        ))}
      </div>

      {!hasKey && (
        <Card className="p-4 text-sm text-muted">
          You need an Anthropic API key first.{" "}
          <Link href="/settings" className="focus-ring rounded font-medium text-brand hover:underline">
            Add one in Settings →
          </Link>
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-faint">Base suggestions on</span>
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
                  disabled={disabledTab}
                  title={
                    disabledTab
                      ? "Available once you've marked watch dates in the app"
                      : undefined
                  }
                  onClick={() => setBasisMode(mode)}
                  className={cn(
                    "focus-ring min-h-10 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
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

          {basisMode === "recent" && (
            <div className="flex flex-wrap items-center gap-1.5">
              {[10, 20, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRecentCount(n)}
                  className={cn(
                    "focus-ring rounded-full px-3 py-1 text-sm ring-1 transition-colors",
                    recentCount === n
                      ? "bg-brand/15 text-brand ring-brand/40"
                      : "text-muted ring-line hover:text-foreground",
                  )}
                >
                  Last {n}
                </button>
              ))}
              <span className="text-xs text-faint">
                Your most recent watches. Imported titles with no watch date fall back to when you added them.
              </span>
            </div>
          )}

          {basisMode === "pick" && (
            <TitlePicker
              selected={pickedIds}
              onToggle={togglePicked}
              onClear={() => setPickedIds(new Set())}
            />
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-faint">How many</span>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={countStr}
              onChange={(e) => setCountStr(e.target.value)}
              onBlur={() => setCountStr(String(count))}
              className="w-24"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-faint">Type</span>
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="all">Movies & TV</option>
              <option value="movie">Movies only</option>
              <option value="tv">TV only</option>
            </Select>
          </label>
          {languages.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-faint">Language</span>
              <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
                <option value="">Any language</option>
                {languages.map((l) => (
                  <option key={l} value={l}>
                    {languageName(l)}
                  </option>
                ))}
              </Select>
            </label>
          )}
          {genres.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-faint">Genre</span>
              <Select value={genre} onChange={(e) => setGenre(e.target.value)}>
                <option value="">Any genre</option>
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </Select>
            </label>
          )}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-faint">Era</span>
            <Select value={era} onChange={(e) => setEra(e.target.value)}>
              <option value="">Any era</option>
              {REC_ERAS.map((er) => (
                <option key={er.id} value={er.id}>
                  {er.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-faint">Model</span>
            <Select value={model} onChange={(e) => changeModel(e.target.value)}>
              {REC_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} · {m.note}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-faint">Focus (optional)</span>
            <Input
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder="e.g. cozy mysteries, something like Bramayugam, 90s sci-fi"
            />
          </label>
        </div>
        <Button
          variant="primary"
          className="self-start"
          disabled={loading || !hasKey || pickEmpty}
          onClick={() => generate({ reset: true })}
        >
          {loading ? <Spinner /> : <Sparkles size={16} />}
          {loading ? "Thinking…" : "Get suggestions"}
        </Button>
        {pickEmpty && (
          <p className="text-xs text-faint">
            Pick at least one title above, or switch to Whole library.
          </p>
        )}
        {error && (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
            {error}
          </p>
        )}
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
                className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground"
              >
                <Square size={13} />
                Stop
              </button>
            ) : (
              <button
                type="button"
                onClick={() => generate()}
                disabled={pickEmpty}
                className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw size={14} />
                Show different
              </button>
            )}
          </div>

          <MotionProvider>
            <AnimatePresence initial={false}>
              {(recs ?? []).map((r) => (
                <motion.div
                  key={`${r.mediaType}:${r.tmdbId ?? r.title}`}
                  layout
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
                >
                  <RecCard rec={r} />
                </motion.div>
              ))}
            </AnimatePresence>
          </MotionProvider>

          {loading &&
            Array.from({ length: Math.min(2, Math.max(1, count - (recs?.length ?? 0))) }).map(
              (_, i) => (
                <Card key={`skeleton-${i}`} className="flex items-start gap-3 p-3">
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
              className="focus-ring flex items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30"
            >
              <Check size={15} /> Added
            </Link>
          ) : (
            <button
              disabled={state.kind === "adding"}
              onClick={() =>
                start(async () => {
                  setState({ kind: "adding" });
                  const res = await addFromTmdb(rec.tmdbId!, rec.mediaType);
                  if (res.id) {
                    setState({ kind: "done", id: res.id });
                  } else {
                    setState({ kind: "idle" });
                    toast.error(
                      res.error ?? "Couldn't add that title. Please try again.",
                    );
                  }
                })
              }
              className="focus-ring brand-gradient flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-[#04121c] hover:opacity-90 disabled:opacity-60"
            >
              {state.kind === "adding" ? <Spinner /> : <Plus size={15} />}
              Watchlist
            </button>
          )
        ) : (
          <Link
            href={`/add?q=${encodeURIComponent(rec.title)}`}
            title="Not matched automatically. Search TMDB to add it."
            className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-muted ring-1 ring-line transition-colors hover:text-foreground"
          >
            <Search size={13} /> Find on TMDB
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
  const [q, setQ] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/titles")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && d?.titles) setTitles(d.titles as TitleIndexEntry[]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your titles…"
            className="h-9 pl-8"
          />
        </div>
        <span className="shrink-0 text-xs tabular-nums text-faint">
          {selected.size} selected
        </span>
        {selected.size > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="focus-ring shrink-0 rounded-lg px-2 py-1 text-xs text-muted hover:text-foreground"
          >
            Clear
          </button>
        )}
      </div>
      {titles === null ? (
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
                onClick={() => onToggle(t.id)}
                className={cn(
                  "focus-ring flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
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
                  {on && <Check size={11} />}
                </span>
                <Icon size={14} className="shrink-0 text-muted" />
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
