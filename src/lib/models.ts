// Client-safe model metadata (no server imports) — shared by the recommend
// engine (server) and the Settings model picker (client).

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
