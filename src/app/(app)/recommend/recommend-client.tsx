"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import type { Recommendation, RecStreamEvent } from "@/lib/recommend";
import { Card } from "@/components/ui";
import { setRecommendModel } from "@/lib/settings-actions";
import { suppressSuggestion, unsuppressSuggestion } from "@/lib/suppression-actions";
import { SuppressionsPanel } from "./suppressions-panel";
import { REC_ERAS, type RecEraId } from "@/lib/models";
import { undoToast } from "@/lib/undo-toast";
import {
  encodeRecommendRememberedState,
  REMEMBERED_COOKIE_NAMES,
  type RecommendRememberedState,
  writeRememberedCookie,
} from "@/lib/remembered-state-client";
import {
  initialRecommendState,
  recommendationIdentity,
  recommendReducer,
} from "./recommend-state";
import { RecommendForm, resolvePreset } from "./recommend-form";
import { TuneResults } from "./tune-results";
import { ModelSettings } from "./model-settings";
import { RecResults } from "./rec-results";
import type { DismissReason } from "./rec-card";

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
  const [run, dispatch] = useReducer(recommendReducer, initialRecommendState);
  const loading = run.status === "streaming";
  // Titles shown this session, so "Show different picks" can ask for fresh ones.
  const seen = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
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
    // The run this card belongs to: a restore after a new run has started must
    // not land in the new run's list.
    const runId = run.runId;
    // Remove the card first: the write is fast and the toast carries Undo, so
    // waiting on the round trip would only make the page feel unresponsive.
    dispatch({ type: "dismiss", identity: recommendationIdentity(rec) });
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
      dispatch({ type: "restore", rec, index, runId });
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
        dispatch({ type: "restore", rec, index, runId });
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
    // A fresh run (button/preset) starts over; "Show different picks" keeps excluding.
    if (over?.reset) seen.current = new Set();
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    dispatch({ type: "start" });
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
        dispatch({
          type: "fail",
          error:
            data?.error ??
            (res.status === 429
              ? "You're going a bit fast. Please wait a moment and try again."
              : `Request failed (${res.status}). Please try again.`),
        });
        return;
      }

      // Results stream in as NDJSON — render each suggestion the moment Claude
      // produces it instead of staring at a spinner for the whole batch.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let receivedTerminalEvent = false;
      const handle = (ev: RecStreamEvent) => {
        // Keeps a stale run's stream events out of the next run; the reducer can't tell runs apart.
        if (abortRef.current !== ac) return;
        if (ev.type === "status") {
          dispatch({ type: "phase", phase: ev.phase });
        } else if (ev.type === "rec") {
          dispatch({ type: "rec", rec: ev.rec });
          rememberSeenTitle(seen.current, ev.rec.title);
        } else if (ev.type === "warning") {
          dispatch({ type: "warning", message: ev.message });
        } else if (ev.type === "error") {
          receivedTerminalEvent = true;
          dispatch({ type: "fail", error: ev.error });
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
        dispatch({
          type: "fail",
          error:
            "This recommendation run was cut short. Anything already suggested is kept; try again for the rest.",
        });
      }
    } catch (e) {
      if (e instanceof StreamStallError) dispatch({ type: "fail", error: e.message });
      else if ((e as Error).name !== "AbortError") {
        dispatch({ type: "fail", error: recommendationError(e) });
      }
    } finally {
      // Keeps a stale run's finish out of the next run; the reducer can't tell runs apart.
      if (abortRef.current === ac) {
        dispatch({
          type: "finish",
          language: language || undefined,
          era: era as RecEraId | "",
          // Only Stop aborts the current run without an error: a stall fails
          // it, and a newer run or leaving the page skips this finish.
          stopped: ac.signal.aborted,
        });
      }
    }
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

      <RecommendForm
        loading={loading}
        hasKey={hasKey}
        pickEmpty={pickEmpty}
        generate={generate}
        focus={focus}
        setFocus={setFocus}
        activePreset={activePreset}
        setActivePreset={setActivePreset}
        tags={tags}
        type={type}
        setType={setType}
        count={count}
        countStr={countStr}
        setCountStr={setCountStr}
        warnings={run.warnings}
        onDismissWarning={(warning) => dispatch({ type: "dismissWarning", warning })}
        error={run.error}
      >
        <TuneResults
          loading={loading}
          hasWatchDates={hasWatchDates}
          basisMode={basisMode}
          setBasisMode={setBasisMode}
          recentCount={recentCount}
          setRecentCount={setRecentCount}
          pickedIds={pickedIds}
          togglePicked={togglePicked}
          clearPicked={() => setPickedIds(new Set())}
          languages={languages}
          language={language}
          setLanguage={setLanguage}
          genres={genres}
          genre={genre}
          setGenre={setGenre}
          era={era}
          setEra={setEra}
        />
        <ModelSettings
          model={model}
          changeModel={changeModel}
          keySource={keySource}
          loading={loading}
        />
      </RecommendForm>

      <RecResults
        run={run}
        count={count}
        pickEmpty={pickEmpty}
        stop={stop}
        generate={generate}
        dismiss={dismiss}
      />

      <SuppressionsPanel refreshKey={suppressionsKey} />
    </div>
  );
}
