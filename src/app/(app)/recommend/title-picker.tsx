"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Film, Search, Tv } from "lucide-react";
import type { TitleIndexEntry } from "@/lib/data";
import { Input } from "@/components/ui";
import { cn } from "@/lib/utils";

export function TitlePicker({
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
            size={16}
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
                    on ? "bg-brand text-on-accent ring-brand" : "ring-line",
                  )}
                >
                  {on && <Check size={11} aria-hidden="true" />}
                </span>
                <Icon size={16} aria-hidden="true" className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                {t.year ? (
                  <span className="shrink-0 text-xs text-faint">{t.year}</span>
                ) : null}
              </button>
            );
          })}
          {q.trim() === "" && titles.length > filtered.length && (
            <p className="px-2 py-1.5 text-center text-xs text-faint">
              Showing the first {filtered.length}. Search to find more.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
