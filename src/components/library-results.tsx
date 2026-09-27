"use client";

import { memo } from "react";
import Link from "next/link";
import { CheckSquare, Heart } from "lucide-react";
import type { LibraryItem } from "@/lib/data";
import { Badge } from "./ui";
import { TitleCard } from "./title-card";
import { IntentLink } from "./intent-link";
import { Poster } from "./poster";
import { useLibraryFilters } from "./library-filters-context";
import { STATUS_META, languageName, progressPct, year } from "@/lib/format";
import { hasFiltersBesidesSearch } from "@/lib/library-filter-state";
import { tagChipClass } from "@/lib/tag-colors";
import { regionName } from "@/lib/tmdb-extras";
import { cn } from "@/lib/utils";

export function uncheckedProviderCopy(count: number): string {
  return `${count} ${count === 1 ? "title" : "titles"} not checked yet`;
}

/** The filtered titles as a grid or list, or the empty state that explains why there are none. */
export function LibraryResults({
  filtered,
  items,
  tagColors,
  selectMode,
  selected,
  onToggle,
  myProviders,
  accountRegion,
  uncheckedServiceCount,
}: {
  filtered: LibraryItem[];
  items: LibraryItem[];
  tagColors?: Record<string, string | null>;
  selectMode: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  myProviders: number[];
  accountRegion: string;
  uncheckedServiceCount: number;
}) {
  const {
    state,
    actions: { set, clear },
  } = useLibraryFilters();
  const { query, view, onlyOnServices } = state;
  const filtersBesidesSearch = hasFiltersBesidesSearch(state);

  return filtered.length === 0 ? (
    <EmptyState
      hasItems={items.length > 0}
      query={query}
      searchOnly={query !== "" && !filtersBesidesSearch}
      onClearSearch={() => set({ query: "" })}
      onClear={clear}
      onlyOnServices={onlyOnServices}
      hasConfiguredProviders={myProviders.length > 0}
      accountRegion={accountRegion}
      uncheckedServiceCount={uncheckedServiceCount}
    />
  ) : view === "grid" ? (
    <div className="grid grid-cols-2 gap-x-4 gap-y-6 min-[480px]:grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
      {filtered.map((it, i) => (
        <TitleCard
          key={it.id}
          item={it}
          selectable={selectMode}
          selected={selected.has(it.id)}
          onToggle={onToggle}
          // LCP: preload the first two cards (the whole first row on a
          // phone), and load the rest of the widest (7-column) row eagerly.
          lcp={i < 2 ? "preload" : i < 7 ? "eager" : undefined}
        />
      ))}
    </div>
  ) : (
    <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line">
      {filtered.map((it) => (
        <ListRow
          key={it.id}
          item={it}
          tagColors={tagColors}
          selectMode={selectMode}
          selected={selected.has(it.id)}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/** Tags shown inline on a row before the rest collapse into a "+n" count. */
const ROW_TAG_LIMIT = 3;

/**
 * Memoized, like TitleCard, so a keystroke's re-render of Library doesn't
 * reconcile every row (VE-04). Its props hold across those renders: item refs
 * come from `items`, tagColors is a server prop, onToggle is the useCallback'd
 * toggle and the rest are booleans.
 */
const ListRow = memo(function ListRow({
  item,
  tagColors,
  selectMode,
  selected,
  onToggle,
}: {
  item: LibraryItem;
  tagColors?: Record<string, string | null>;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const status = STATUS_META[item.status];
  const isTv = item.mediaType === "TV";
  const pct = isTv ? progressPct(item.watchedEpisodes, item.totalEpisodes) : 0;
  // Tags were stored, filtered on and never shown, so the only way to see what a
  // title was tagged with was to open it. Shown here in the colour set in
  // Settings, and capped so a heavily tagged title can't push the row's own
  // identity out of view.
  const shownTags = item.tags.slice(0, ROW_TAG_LIMIT);
  const hiddenTagCount = item.tags.length - shownTags.length;

  const inner = (
    <>
      <div className="w-9 shrink-0">
        <Poster
          path={item.posterPath}
          name={item.name}
          decorative
          mediaType={item.mediaType}
          size="w92"
          sizes="36px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
          {item.favorite && (
            <span>
              <Heart size={12} aria-hidden="true" className="fill-rose-400 text-rose-400" />
              <span className="sr-only">Favorite</span>
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {isTv ? "TV" : "Movie"} · {year(item.releaseDate) || "Unknown"}
          {isTv && item.totalEpisodes ? ` · ${item.watchedEpisodes}/${item.totalEpisodes} eps (${pct}%)` : ""}
          {item.language ? ` · ${languageName(item.language)}` : ""}
          {item.rating ? ` · ★ ${item.rating}` : ""}
        </div>
        {shownTags.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {shownTags.map((t) => (
              <span
                key={t}
                title={t}
                className={cn(
                  // inline-block, not inline-flex: `truncate` needs a block
                  // formatting context for its ellipsis to actually render.
                  "inline-block max-w-32 truncate rounded-full px-2 py-0.5 align-middle text-xs font-medium ring-1 ring-inset",
                  tagChipClass(tagColors?.[t]),
                )}
              >
                {t}
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span className="text-xs tabular-nums text-faint">
                +{hiddenTagCount}
              </span>
            )}
          </div>
        )}
      </div>
      <Badge className={status.badge}>
        <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
        {status.label}
      </Badge>
    </>
  );

  if (selectMode) {
    return (
      <button
        onClick={() => onToggle(item.id)}
        aria-pressed={selected}
        className={cn(
          "cv-auto focus-ring focus-ring-inset flex items-center gap-3 px-3 py-2.5 text-left transition-colors active:bg-surface-2/60 active:duration-0",
          selected ? "bg-brand/10" : "bg-surface hover:bg-surface-2/50",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded ring-1",
            selected ? "bg-brand text-on-accent ring-brand" : "ring-line-strong",
          )}
        >
          {selected && <CheckSquare size={13} />}
        </span>
        {inner}
      </button>
    );
  }

  return (
    <IntentLink
      href={`/title/${item.id}`}
      className="cv-auto focus-ring focus-ring-inset flex items-center gap-3 bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2/50 active:bg-surface-2/60 active:duration-0"
    >
      {inner}
    </IntentLink>
  );
});

function EmptyState({
  hasItems,
  query,
  searchOnly,
  onClearSearch,
  onClear,
  onlyOnServices,
  hasConfiguredProviders,
  accountRegion,
  uncheckedServiceCount,
}: {
  hasItems: boolean;
  query: string;
  /** The search is the only thing narrowing the view. */
  searchOnly: boolean;
  onClearSearch: () => void;
  onClear: () => void;
  onlyOnServices: boolean;
  hasConfiguredProviders: boolean;
  accountRegion: string;
  uncheckedServiceCount: number;
}) {
  if (hasItems && onlyOnServices) {
    return (
      <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-line px-5 py-16 text-center">
        <p className="text-sm font-medium text-foreground">
          {hasConfiguredProviders
            ? `No titles are confirmed on your services in ${regionName(accountRegion)}.`
            : "Choose your streaming services to see what you can watch tonight."}
        </p>
        <p className="mt-2 max-w-xl text-sm text-muted">
          {uncheckedServiceCount > 0
            ? `${uncheckedProviderCopy(uncheckedServiceCount)} for ${regionName(accountRegion)}. Availability refreshes nightly.`
            : hasConfiguredProviders
              ? "All eligible titles have been checked. Provider catalogues can still change between nightly refreshes."
            : "Add the subscriptions you use in Settings, then this one-tap view will match them against availability refreshed each night."}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-1">
          <Link
            href="/settings"
            className="focus-ring flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium text-brand hover:underline sm:min-h-0"
          >
            {hasConfiguredProviders ? "Review services and region" : "Choose my services"}
          </Link>
          <span className="text-faint">·</span>
          <button
            type="button"
            onClick={onClear}
            className="focus-ring flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm text-muted hover:text-foreground sm:min-h-0"
          >
            Show full library
          </button>
        </div>
        <p className="mt-3 text-xs text-faint">Availability data via JustWatch</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line px-5 py-20 text-center">
      {/* A no-match state names the query; a first-run state says what the
          place is for (JK-31). */}
      {hasItems ? (
        <p className="max-w-full break-words text-sm text-muted">
          {query.trim()
            ? `No titles match “${query.trim()}”${searchOnly ? "." : " with these filters."}`
            : "No titles match your filters."}
        </p>
      ) : (
        <div>
          <p className="text-sm font-medium text-foreground">Your library is empty.</p>
          <p className="mt-1 max-w-sm text-sm text-muted">
            Titles you add show up here with your progress and ratings.
          </p>
        </div>
      )}
      {hasItems ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={searchOnly ? onClearSearch : onClear}
            className="focus-ring flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium text-brand hover:underline sm:min-h-0"
          >
            {searchOnly ? "Clear search" : "Clear filters"}
          </button>
          <span className="text-faint">·</span>
          <Link
            href="/add"
            className="focus-ring flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm text-muted hover:text-foreground sm:min-h-0"
          >
            Add a title
          </Link>
        </div>
      ) : (
        <Link
          href="/add"
          className="focus-ring inline-flex min-h-11 items-center rounded text-sm font-medium text-brand hover:underline sm:min-h-0"
        >
          Add your first title
        </Link>
      )}
    </div>
  );
}
