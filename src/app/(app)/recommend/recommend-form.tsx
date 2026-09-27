"use client";

import { Sparkles } from "lucide-react";
import { Button, Card, Input, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

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

export function resolvePreset(
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

const COUNT_OPTIONS = [6, 12, 20] as const;

/**
 * The taste brief: focus, quick starts, type and count, the submit button and
 * the run's notices. The collapsible sections come in as children.
 */
export function RecommendForm({
  loading,
  hasKey,
  pickEmpty,
  generate,
  focus,
  setFocus,
  activePreset,
  setActivePreset,
  tags,
  type,
  setType,
  count,
  countStr,
  setCountStr,
  warnings,
  onDismissWarning,
  error,
  children,
}: {
  loading: boolean;
  hasKey: boolean;
  pickEmpty: boolean;
  generate: (over: { reset: boolean }) => Promise<void>;
  focus: string;
  setFocus: (focus: string) => void;
  activePreset: string | null;
  setActivePreset: (key: string | null) => void;
  tags: string[];
  type: "all" | "movie" | "tv";
  setType: (type: "all" | "movie" | "tv") => void;
  count: number;
  countStr: string;
  setCountStr: (value: string) => void;
  warnings: string[];
  onDismissWarning: (warning: string) => void;
  error: string | null;
  children: React.ReactNode;
}) {
  function applyPreset(key: string, p: { focus: string; type?: "movie" | "tv" }) {
    setActivePreset(key);
    setFocus(p.focus);
    if (p.type) setType(p.type);
  }

  return (
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
                  ["all", "All"],
                  ["movie", "Movies"],
                  ["tv", "TV shows"],
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
                  // sm:h-8 matches the 32px count pills beside it (JK-36).
                  className="w-20 text-center tabular-nums sm:h-8"
                />
              </label>
            </div>
          </fieldset>
        </div>

        {children}

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
              onClick={() => onDismissWarning(warning)}
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
  );
}
