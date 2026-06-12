// Client-safe recommend metadata (no server imports) — shared by the recommend
// engine (server) and the recommend page controls (client).

export const REC_MODELS = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", note: "Most capable · default" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", note: "Faster, lower cost" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", note: "Fastest, cheapest" },
] as const;

export type RecModelId = (typeof REC_MODELS)[number]["id"];

export const DEFAULT_REC_MODEL: RecModelId = "claude-opus-4-8";

export function isRecModel(id: string | null | undefined): id is RecModelId {
  return !!id && REC_MODELS.some((m) => m.id === id);
}

export function recModelLabel(id: string | null | undefined): string {
  return REC_MODELS.find((m) => m.id === id)?.label ?? "Claude Opus 4.8";
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

// Per-model request-surface capabilities. Opus 4.8 / Sonnet 4.6 take adaptive
// thinking + the `effort` knob; Haiku 4.5 rejects `effort` (400) and has no
// adaptive thinking, so we omit both for it.
export const MODEL_CAPS: Record<
  RecModelId,
  { effort: boolean; adaptiveThinking: boolean }
> = {
  "claude-opus-4-8": { effort: true, adaptiveThinking: true },
  "claude-sonnet-4-6": { effort: true, adaptiveThinking: true },
  "claude-haiku-4-5": { effort: false, adaptiveThinking: false },
};
