import type { Recommendation } from "@/lib/recommend";
import { REC_ERAS, type RecEraId } from "@/lib/models";

/**
 * The recommend page's request lifecycle, held in one reducer (VE-08).
 *
 * - idle: no run yet on this page view.
 * - streaming: a request is open. `error` can already be set: the server's
 *   error event arrives before the stream closes, and the form shows it while
 *   the run winds down.
 * - done: the run ended without an error, including one the owner stopped
 *   (`stopped`).
 * - error: the run ended with an error. Picks that arrived before it are kept.
 *
 * Every state carries the run's results, because dismiss and Undo change the
 * cards whatever the request is doing.
 */
export type StreamPhase = "starting" | "thinking" | "generating";

type RunResults = {
  /**
   * Counts runs on this page view; start bumps it. An Undo, or a failed hide,
   * names the run its card came from, and a card from an earlier run is not
   * put back into a later run's list.
   */
  runId: number;
  /** The cards on screen: streamed picks minus dismissed ones, ranked once the run ends. */
  recs: Recommendation[];
  /** Every pick this run streamed, in arrival order, dismissed ones included. */
  received: Recommendation[];
  /** Identities dismissed during this run, so later stream events keep them hidden. */
  dismissed: ReadonlySet<string>;
  /**
   * A single run can emit more than one distinct warning (e.g. a key-fallback
   * notice up front, then a max-tokens partial notice at the end), so keep
   * them all instead of the last one clobbering the rest.
   */
  warnings: string[];
};

export type RecommendState = RunResults &
  (
    | { status: "idle"; error: null }
    | { status: "streaming"; phase: StreamPhase; error: string | null }
    | { status: "done"; error: null; stopped: boolean }
    | { status: "error"; error: string }
  );

export type RecommendAction =
  | { type: "start" }
  | { type: "phase"; phase: StreamPhase }
  | { type: "rec"; rec: Recommendation }
  | { type: "warning"; message: string }
  | { type: "fail"; error: string }
  | { type: "finish"; language: string | undefined; era: RecEraId | ""; stopped: boolean }
  | { type: "dismiss"; identity: string }
  | { type: "restore"; rec: Recommendation; index: number; runId: number }
  | { type: "dismissWarning"; warning: string };

export const initialRecommendState: RecommendState = {
  status: "idle",
  error: null,
  runId: 0,
  recs: [],
  received: [],
  dismissed: new Set(),
  warnings: [],
};

export function recommendationIdentity(rec: Recommendation): string {
  return rec.tmdbId != null
    ? `${rec.mediaType}:tmdb:${rec.tmdbId}`
    : `${rec.mediaType}:name:${rec.title.trim().toLocaleLowerCase()}:${rec.year ?? "?"}`;
}

function visibleRecommendations(
  recommendations: Recommendation[],
  dismissed: ReadonlySet<string>,
): Recommendation[] {
  return recommendations.filter((rec) => !dismissed.has(recommendationIdentity(rec)));
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
function restoreAt(list: Recommendation[], rec: Recommendation, index: number): Recommendation[] {
  const next = [...list];
  if (next.includes(rec)) return next;
  next.splice(Math.min(index, next.length), 0, rec);
  return next;
}

function results({ runId, recs, received, dismissed, warnings }: RecommendState): RunResults {
  return { runId, recs, received, dismissed, warnings };
}

export function recommendReducer(
  state: RecommendState,
  action: RecommendAction,
): RecommendState {
  switch (action.type) {
    case "start":
      return {
        status: "streaming",
        phase: "starting",
        error: null,
        runId: state.runId + 1,
        recs: [],
        received: [],
        dismissed: new Set(),
        warnings: [],
      };
    case "phase":
      return state.status === "streaming" && state.phase !== action.phase
        ? { ...state, phase: action.phase }
        : state;
    case "rec": {
      if (state.status !== "streaming") return state;
      const received = [...state.received, action.rec];
      return { ...state, received, recs: visibleRecommendations(received, state.dismissed) };
    }
    case "warning":
      return state.status === "streaming" && !state.warnings.includes(action.message)
        ? { ...state, warnings: [...state.warnings, action.message] }
        : state;
    case "fail":
      // The latest error wins. Mid-run it waits for the run to wind down.
      return state.status === "streaming"
        ? { ...state, error: action.error }
        : { ...results(state), status: "error", error: action.error };
    case "finish": {
      if (state.status !== "streaming") return state;
      // Ranking runs on whatever arrived: full run, stopped early, or errored
      // partway (partial results stay useful alongside the error message).
      const recs =
        state.received.length > 0
          ? rankRecs(
              visibleRecommendations(state.received, state.dismissed),
              action.language,
              action.era,
            )
          : state.recs;
      return state.error === null
        ? { ...results(state), recs, status: "done", error: null, stopped: action.stopped }
        : { ...results(state), recs, status: "error", error: state.error };
    }
    case "dismiss":
      return {
        ...state,
        dismissed: new Set(state.dismissed).add(action.identity),
        recs: state.recs.filter((item) => recommendationIdentity(item) !== action.identity),
      };
    case "restore": {
      if (action.runId !== state.runId) return state;
      const dismissed = new Set(state.dismissed);
      dismissed.delete(recommendationIdentity(action.rec));
      return { ...state, dismissed, recs: restoreAt(state.recs, action.rec, action.index) };
    }
    case "dismissWarning":
      return { ...state, warnings: state.warnings.filter((item) => item !== action.warning) };
  }
}
