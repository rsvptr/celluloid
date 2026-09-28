"use client";

import { useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { Clapperboard, Plus, Search, SlidersHorizontal, X } from "lucide-react";
import type { LibraryItem } from "@/lib/data";
import type { TypeFilter } from "@/lib/library-filters";
import {
  hasLibraryFilters,
  libraryChipFocusAfterRemoval,
  libraryFilterChips,
  libraryMirrorFilters,
} from "@/lib/library-filter-state";
import { Input } from "./ui";
import { useLibraryFilters } from "./library-filters-context";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

// The filter rows of the library toolbar. The utilities row (select, surprise,
// share, view) stays in Library, which owns the selection it drives.

// Segmented quick-filter options, wired to the same `type` state (and URL param)
// the advanced-panel <Select> used to drive.
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "MOVIE", label: "Movies" },
  { value: "TV", label: "TV shows" },
];

// Primary CTA rendered as a real anchor (Link to /add). Mirrors
// <Button variant="primary" size="md"> from ui.tsx. That primitive can't take
// an href, and ui.tsx is out of this task's scope, so its classes are inlined.
const addTitleButtonClass =
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg brand-gradient px-4 text-sm font-semibold text-on-accent shadow-sm shadow-brand/20 press hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 sm:min-h-10";

// Row 1, primary: the search is the dominant utility, next to a live result
// count and the one high-emphasis action (Add title).
export function LibrarySearchRow({
  searchInputRef,
  filtered,
  items,
}: {
  searchInputRef: RefObject<HTMLInputElement | null>;
  filtered: LibraryItem[];
  items: LibraryItem[];
}) {
  const {
    state,
    actions: { set },
  } = useLibraryFilters();
  const { query } = state;
  // Trimmed, as the results are: a search of only spaces narrows nothing.
  const hasFilters = hasLibraryFilters(libraryMirrorFilters(state));

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="relative order-last w-full min-w-0 sm:order-none sm:w-auto sm:max-w-md sm:flex-1">
        <Search
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
        />
        <Input
          ref={searchInputRef}
          value={query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Search your library…"
          aria-label="Search your library"
          spellCheck={false}
          className="pl-9"
        />
      </div>
      <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-normal">
        <p
          role="status"
          aria-live="polite"
          className="shrink-0 text-xs tabular-nums text-muted"
        >
          {formatCount(filtered.length)} {filtered.length === 1 ? "title" : "titles"}
          {hasFilters ? ` of ${formatCount(items.length)}` : ""}
        </p>
        <Link href="/add" className={addTitleButtonClass}>
          <Plus size={16} /> Add title
        </Link>
      </div>
    </div>
  );
}

// Row 2, contextual: a type quick-filter and the single entry point to the
// advanced facets, on every width.
export function LibraryFilterRow({
  firstRun,
  myProviders,
  showFilters,
  onToggleFilters,
  filtersTriggerRef,
}: {
  firstRun: boolean;
  myProviders: number[];
  showFilters: boolean;
  onToggleFilters: () => void;
  filtersTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const {
    state,
    actions: { set },
  } = useLibraryFilters();
  const { type, onlyOnServices } = state;
  const advancedCount = libraryFilterChips(state).length;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", firstRun && "hidden")}>
      <div
        role="group"
        aria-label="Filter by type"
        className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line"
      >
        {TYPE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => set({ type: opt.value })}
            aria-pressed={type === opt.value}
            className={cn(
              "focus-ring flex min-h-11 items-center justify-center rounded-md px-3 text-sm press sm:min-h-8",
              type === opt.value
                ? "bg-surface text-foreground shadow-sm"
                : "text-muted hover:text-foreground",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => set((f) => ({ onlyOnServices: !f.onlyOnServices }))}
        aria-pressed={onlyOnServices}
        title={
          myProviders.length > 0
            ? `Show titles available on your ${myProviders.length} selected ${myProviders.length === 1 ? "service" : "services"}`
            : "Choose your services in Settings"
        }
        className={cn(
          "focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm ring-1 press sm:min-h-8",
          onlyOnServices
            ? "bg-brand/15 text-brand ring-brand/40"
            : "text-muted ring-line hover:text-foreground",
        )}
      >
        <Clapperboard aria-hidden="true" size={16} />
        On my services
      </button>
      <button
        ref={filtersTriggerRef}
        type="button"
        onClick={onToggleFilters}
        aria-expanded={showFilters}
        aria-controls="library-advanced-filters"
        aria-label={advancedCount > 0 ? `Filters, ${advancedCount} active` : "Filters"}
        className={cn(
          "focus-ring ml-auto flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm ring-1 press sm:min-h-8",
          showFilters || advancedCount > 0
            ? "bg-surface-2 text-foreground ring-line-strong"
            : "text-muted ring-line hover:text-foreground",
        )}
      >
        <SlidersHorizontal size={16} />
        Filters
        {advancedCount > 0 && (
          <span
            aria-hidden
            className="inline-flex min-w-5 items-center justify-center rounded-full bg-brand/15 px-1.5 text-xs font-medium tabular-nums text-brand"
          >
            {advancedCount}
          </span>
        )}
      </button>
    </div>
  );
}

// Active-filter chips: one removable chip per active facet, shown whether or
// not the advanced panel is open. Removing a chip, or all of them, unmounts the
// button that had focus, so focus moves to the chip that took its place, or to
// `fallbackFocusRef` once no chip is left.
export function LibraryFilterChips({
  fallbackFocusRef,
}: {
  fallbackFocusRef: RefObject<HTMLElement | null>;
}) {
  const {
    state,
    actions: { set, clear },
  } = useLibraryFilters();
  const chipsRef = useRef<HTMLDivElement>(null);
  const facetChips = libraryFilterChips(state);
  if (facetChips.length === 0) return null;

  function focusChipOrFallback(key: string | null) {
    const chip = key
      ? chipsRef.current?.querySelector<HTMLElement>(`[data-chip="${key}"]`)
      : null;
    (chip ?? fallbackFocusRef.current)?.focus();
  }

  return (
    <div ref={chipsRef} className="flex flex-wrap items-center gap-2">
      {facetChips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          data-chip={chip.key}
          onClick={() => {
            const next = libraryChipFocusAfterRemoval(facetChips, chip.key);
            flushSync(() => set(chip.clear));
            focusChipOrFallback(next);
          }}
          aria-label={`Remove ${chip.label} filter`}
          className="focus-ring flex min-h-11 min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs text-foreground ring-1 ring-line press hover:text-foreground sm:min-h-0 sm:py-1"
        >
          <span className="break-words">{chip.label}</span>
          <X size={13} aria-hidden className="text-muted" />
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          flushSync(clear);
          focusChipOrFallback(null);
        }}
        className="focus-ring flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:text-foreground sm:min-h-0"
      >
        Clear all
      </button>
    </div>
  );
}
