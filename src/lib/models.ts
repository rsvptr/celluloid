// Client-safe recommend metadata (no server imports) — shared by the recommend
// engine (server) and the recommend page controls (client).

export const REC_MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Most capable · can take longer" },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    note: "Near-Opus quality, faster · default",
  },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fastest, cheapest" },
] as const;

export type RecModelId = (typeof REC_MODELS)[number]["id"];

export const DEFAULT_REC_MODEL: RecModelId = "claude-sonnet-5";

export function isRecModel(id: string | null | undefined): id is RecModelId {
  return !!id && REC_MODELS.some((m) => m.id === id);
}

// Ids the lineup used to offer, each with the current model of its family. A
// saved preference, an old backup or a tab opened before the lineup changed
// can still name one.
const RETIRED_REC_MODELS = new Map<string, RecModelId>([["claude-opus-5", "claude-opus-5-5"]]);

/**
 * The model a known id runs on: a current id as it is, a retired one on its
 * successor. Anything else is null, so the recommend route can reject it
 * rather than run a model nobody picked.
 */
export function knownRecModel(id: string | null | undefined): RecModelId | null {
  if (isRecModel(id)) return id;
  return (id && RETIRED_REC_MODELS.get(id)) || null;
}

/**
 * The model a stored preference runs on: a known id as knownRecModel maps it,
 * and anything else the default, so the picker and the engine never see an id
 * they can't use.
 */
export function resolveRecModel(id: string | null | undefined): RecModelId {
  return knownRecModel(id) ?? DEFAULT_REC_MODEL;
}

export function recModelLabel(id: string | null | undefined): string {
  return REC_MODELS.find((m) => m.id === id)?.label ?? "Claude Sonnet 5";
}

// Era choices for the recommendation "Era" preference. The clause is what gets
// woven into the prompt; the range lets the result ranker confirm a match from
// the TMDB-resolved year.
export const REC_ERAS = [
  { id: "2020s", label: "2020s", clause: "released in the 2020s", range: [2020, 2029] },
  { id: "2010s", label: "2010s", clause: "released in the 2010s", range: [2010, 2019] },
  { id: "2000s", label: "2000s", clause: "released in the 2000s", range: [2000, 2009] },
  { id: "1990s", label: "1990s", clause: "released in the 1990s", range: [1990, 1999] },
  { id: "1980s", label: "1980s", clause: "released in the 1980s", range: [1980, 1989] },
  { id: "1970s", label: "1970s", clause: "released in the 1970s", range: [1970, 1979] },
  { id: "pre-1970", label: "Before 1970", clause: "released before 1970", range: [1870, 1969] },
] as const;

export type RecEraId = (typeof REC_ERAS)[number]["id"];

export function isRecEra(id: string | null | undefined): id is RecEraId {
  return !!id && REC_ERAS.some((e) => e.id === id);
}

export function eraById(id: RecEraId) {
  return REC_ERAS.find((e) => e.id === id)!;
}

// Per-model request-surface capabilities. Opus 5.5 / Sonnet 5 take adaptive
// thinking + the `effort` knob; Haiku 4.5 rejects `effort` (400) and has no
// adaptive thinking, so we omit both for it. Opus 5.5 can't turn thinking off
// at all (`disabled` and `budget_tokens` both 400), so effort is its only
// thinking control. `serverFallback` opts a model into Anthropic's server-side
// refusal fallback: Opus 5.5's safety classifiers can decline a request, and
// the fallback reruns it on the model Anthropic recommends for that kind of
// refusal instead of failing the run. (A saved default that names a retired
// entry is mapped by resolveRecModel.)
export const MODEL_CAPS: Record<
  RecModelId,
  { effort: boolean; adaptiveThinking: boolean; serverFallback: boolean }
> = {
  "claude-opus-5-5": { effort: true, adaptiveThinking: true, serverFallback: true },
  "claude-sonnet-5": { effort: true, adaptiveThinking: true, serverFallback: false },
  "claude-haiku-4-5": { effort: false, adaptiveThinking: false, serverFallback: false },
};

// Shortest prefix Anthropic will actually cache, in tokens. A cache_control
// breakpoint on anything shorter is accepted and then silently ignored — no
// error, no field in the response to notice — so the recommend engine only
// attaches one when the prefix plausibly clears the model's bar. These are not
// monotonic across generations (Opus 5.5 and Opus 5 sit at half Opus 4.8's
// 1024), so a model swap has to revisit this map rather than assume the newer
// number is lower.
export const MODEL_CACHE_MIN_TOKENS: Record<RecModelId, number> = {
  "claude-opus-5-5": 512,
  "claude-sonnet-5": 1024,
  "claude-haiku-4-5": 4096,
};
