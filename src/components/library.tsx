"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { filtersToParams, type LibraryFilters } from "@/lib/library-filters";
import {
  libraryFiltersReducer,
  libraryMirrorFilters,
  libraryResultsKey,
  libraryUrlFilters,
  toLibraryFilterState,
  type LibraryFilterUpdate,
  type LibraryResultCriteria,
} from "@/lib/library-filter-state";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckSquare, Dices, LayoutGrid, List, Share2 } from "lucide-react";
import { toast } from "sonner";
import type { LibraryItem, TrashedTitle } from "@/lib/data";
import dynamic from "next/dynamic";
import { whenIdle } from "@/lib/when-idle";
import { BulkBar } from "./library-bulk-bar";
import { LibraryFilterPanel } from "./library-filter-panel";
import { LibraryFiltersContext } from "./library-filters-context";
import { LibraryResults, uncheckedProviderCopy } from "./library-results";
import { LibraryFilterChips, LibraryFilterRow, LibrarySearchRow } from "./library-toolbar";
import { TrashView } from "./library-trash";
import { fullDate } from "@/lib/format";
import { regionName } from "@/lib/tmdb-extras";
import { cn } from "@/lib/utils";
import {
  encodeLibraryRememberedState,
  REMEMBERED_COOKIE_NAMES,
  writeRememberedCookie,
} from "@/lib/remembered-state-client";

// Defined beside the empty state that also uses it; importable from the entry
// like this module's other helpers.
export { uncheckedProviderCopy };

// Keeps Radix Dialog out of the library's first load (VE-11). ssr: false gives
// it its own Suspense boundary, so loading it never suspends the library.
const ShareDialog = dynamic(() => import("./share-dialog").then((m) => m.ShareDialog), {
  ssr: false,
});

/**
 * Case- and diacritic-insensitive fold for search. A library that leans
 * international is full of titles the owner will type unaccented — "amelie" for
 * "Amélie", "rashomon" for "Rashōmon" — and a raw `toLowerCase().includes()`
 * silently returns nothing for those, which reads as "I don't own this".
 * NFD splits base characters from their combining marks so the marks can be
 * dropped; \p{Diacritic} needs the `u` flag.
 */
function fold(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

type ServiceAvailabilityState = "MATCH" | "NO_MATCH" | "UNCHECKED" | "INELIGIBLE";

/**
 * Availability in `region`, without treating unknown as no. Callers pass the
 * account region (D-008), which is the one the nightly sync stamps onto
 * `providersRegion`; a device cookie pointing somewhere else would make every
 * cached row read as unchecked.
 */
export function serviceAvailabilityState(
  item: Pick<
    LibraryItem,
    | "tmdbId"
    | "status"
    | "providersRegion"
    | "providersSyncedAt"
    | "streamProviderIds"
  >,
  region: string,
  myProviderIds: ReadonlySet<number>,
): ServiceAvailabilityState {
  if (item.tmdbId === null || item.status === "DROPPED") return "INELIGIBLE";
  if (item.providersSyncedAt === null || item.providersRegion !== region) {
    return "UNCHECKED";
  }
  return item.streamProviderIds.some((id) => myProviderIds.has(id))
    ? "MATCH"
    : "NO_MATCH";
}

export function Library({
  items,
  languages,
  tags,
  tagColors,
  genres,
  trashed,
  initialFilters,
  myProviders,
  accountRegion,
  providerStaleBefore,
  rememberFilters,
}: {
  items: LibraryItem[];
  languages: string[];
  tags: string[];
  /**
   * Tag name -> stored colour, for rendering a title's tags in the colour the
   * owner picked in Settings. Optional because a caller that has only the names
   * still renders correct (neutral) chips.
   */
  tagColors?: Record<string, string | null>;
  genres: string[];
  trashed: TrashedTitle[];
  initialFilters: LibraryFilters;
  myProviders: number[];
  /** Account region: the saved preference, or Celluloid's default (D-008). */
  accountRegion: string;
  /** Server-stamped ISO cutoff (page render time minus seven days). */
  providerStaleBefore: string;
  rememberFilters: boolean;
}) {
  const router = useRouter();
  // Trash is a distinct mode that replaces the whole toolbar + grid; entered from
  // the Filters panel, exited via "Back to library". trashedCount drives the entry.
  const [trashMode, setTrashMode] = useState(false);
  const trashedCount = trashed.length;
  // Tracks the trashedCount last reconciled against trashMode, so the render-time
  // adjustment below (React's "adjusting state when a prop changes" pattern) runs
  // its setState exactly once per actual count change instead of looping.
  const [reconciledTrashedCount, setReconciledTrashedCount] = useState(trashedCount);
  // The filters the address bar holds. They differ from initialFilters only
  // when the page came back from the router's cache for an earlier URL (Back
  // to a URL this component had mirrored), and then the address bar is right.
  const searchParams = useSearchParams();
  const urlFilters = libraryUrlFilters(
    initialFilters,
    searchParams,
    { languages, tags, genres },
    rememberFilters,
  );
  const [filters, dispatchFilters] = useReducer(
    libraryFiltersReducer,
    urlFilters,
    toLibraryFilterState,
  );
  const { query, view, onlyOnServices } = filters;
  const setFilters = (update: LibraryFilterUpdate) =>
    dispatchFilters({ type: "set", update });
  // The router's URL the filters were last taken from, so a navigation can be
  // told from a re-render of the same URL.
  const urlKey = searchParams.toString();
  const [appliedUrlKey, setAppliedUrlKey] = useState(urlKey);

  // Adopt the address bar's filters when the router's URL changes, adjusted
  // during render (React's "adjusting state when a prop changes" pattern, the
  // same one the Trash count uses below). <Library> used to be keyed on the
  // server's filters instead: once any filter had been changed, the re-render
  // that ends every bulk and Trash action brought filters other than the
  // mounted ones, the key changed, and the remount threw away select mode, the
  // selection, the open filters panel and Trash mode. Adopting on those same
  // filters kept that state but still reset the search: the router never sees
  // the mirror's replaceState, so the re-render is for the URL it last
  // navigated to, whose filters (on a bare URL with remember-filters on, the
  // cookie's, which has no search) the owner may have changed since. The
  // router's URL changes only on a navigation or Back/Forward, never on a
  // re-render or the mirror's own write, so typing is never reset either.
  if (urlKey !== appliedUrlKey) {
    setAppliedUrlKey(urlKey);
    dispatchFilters({ type: "adopt", filters: urlFilters });
  }

  // The single advanced-filters disclosure (all widths); collapsed by default.
  const [showFilters, setShowFilters] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [shareIds, setShareIds] = useState<string[]>([]);
  // The share dialog mounts once the page is idle, or on the first open if
  // that comes sooner, and then stays mounted so it can animate out (EM-03).
  // Mounting ahead of the click matters: a lazy component that first suspends
  // on the click shows up no sooner than 300 ms later (React throttles
  // Suspense reveals), even with its chunk already cached.
  const [shareMounted, setShareMounted] = useState(false);
  useEffect(() => whenIdle(() => setShareMounted(true)), []);
  // Remember what was focused when the share dialog opened, to restore on close.
  const shareOpener = useRef<HTMLElement | null>(null);
  // The advanced-filters disclosure trigger, so Escape can return focus to it.
  const filtersTriggerRef = useRef<HTMLButtonElement>(null);
  // Target of the "/" focus shortcut (see the keydown effect below).
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Mirror the view into the URL (replaceState: no history spam, no server
  // round trip) so the current filters are shareable, bookmarkable, and restored
  // when you come back from a title detail via the browser's Back button.
  //
  // Debounced ~300ms trailing (PERF-1): `query` is a dep, so an undebounced
  // version fires this on every keystroke. Safari throttles replaceState to
  // ~100 calls/30s and throws a SecurityError past that. The very first mirror
  // (initial mount) still runs immediately so a stale query string is never
  // briefly on screen, and so does the one after a server re-render (below);
  // only a filter change is debounced. The cookie write
  // is additionally skipped when its encoded value hasn't changed since the
  // last write (mirrorLastCookieRef) — the cookie doesn't even carry `query`
  // (see LibraryRememberedState), so same-query keystrokes were writing an
  // identical value on every call.
  const mirrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The server filters the mirror last ran with; null before its first run.
  const mirrorServerFiltersRef = useRef<LibraryFilters | null>(null);
  const mirrorLastCookieRef = useRef<string | null | undefined>(undefined);
  // Holds the latest pending mirror so the unmount-flush effect below can run
  // it directly instead of re-deriving filter state from scratch.
  const mirrorPendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const currentFilters = libraryMirrorFilters(filters);

    // Captured while mounted on the library route. A debounced (or
    // unmount-flushed) mirror can fire after an SPA navigation has already
    // swapped window.location to another route — writing the library's query
    // string onto that page's URL. The URL half is therefore guarded on the
    // pathname still matching; the cookie half is path-independent and safe.
    const pathname = window.location.pathname;
    const mirror = () => {
      const qs = filtersToParams(currentFilters).toString();
      const next = qs ? `${pathname}?${qs}` : pathname;
      if (
        window.location.pathname === pathname &&
        `${window.location.pathname}${window.location.search}` !== next
      ) {
        window.history.replaceState(window.history.state, "", next);
      }
      if (rememberFilters) {
        const encoded = encodeLibraryRememberedState(currentFilters);
        if (encoded !== mirrorLastCookieRef.current) {
          writeRememberedCookie(REMEMBERED_COOKIE_NAMES.library, encoded);
          mirrorLastCookieRef.current = encoded;
        }
      }
      mirrorPendingRef.current = null;
    };

    // The first run, and the first after a server re-render, mirror at once.
    // The re-render has just had the router write its own URL over the
    // address bar, and a navigation within a debounce would leave that URL on
    // the library's history entry: the router pushes the new route before the
    // unmount flush below runs, so the flush's pathname guard skips the write.
    if (mirrorServerFiltersRef.current !== initialFilters) {
      mirrorServerFiltersRef.current = initialFilters;
      mirror();
      return;
    }

    mirrorPendingRef.current = mirror;
    mirrorTimeoutRef.current = setTimeout(mirror, 300);
    return () => {
      if (mirrorTimeoutRef.current !== null) {
        clearTimeout(mirrorTimeoutRef.current);
        mirrorTimeoutRef.current = null;
      }
    };
    // The reducer returns the same state when nothing changed, so this runs
    // exactly when a filter does, as it did with a dependency per filter.
    // initialFilters is new on every server re-render (router.refresh, a
    // server action), and each of those has the router rewrite the address
    // bar to the last URL it navigated to, so the mirror runs again after it,
    // at once.
  }, [filters, rememberFilters, initialFilters]);

  // Flushes a still-pending debounced mirror on unmount so the last keystroke's
  // filters aren't lost — the cleanup above only cancels a stale timer between
  // re-runs, it never fires the pending write. Empty deps: this must run only
  // on true unmount, not on every dep change the effect above reacts to.
  useEffect(() => {
    return () => {
      if (mirrorTimeoutRef.current !== null) {
        clearTimeout(mirrorTimeoutRef.current);
        mirrorTimeoutRef.current = null;
      }
      mirrorPendingRef.current?.();
    };
  }, []);

  // Folded search text per title, computed once per library rather than once per
  // keystroke per title. Keyed by id so the map survives unrelated re-renders.
  const searchIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const it of items) index.set(it.id, fold(it.name));
    return index;
  }, [items]);

  const myProviderIds = useMemo(() => new Set(myProviders), [myProviders]);

  // Defers the filter/sort recompute (up to ~2k items) to a lower priority than
  // the keystroke itself, so the input stays responsive while `filtered` — and
  // the live result count derived from it — catches up a beat behind typing.
  const deferredQuery = useDeferredValue(query);

  // Keyed on the narrowing fields rather than the whole state, which also
  // changes with every keystroke and view switch (see libraryResultsKey); the
  // criteria are read back out of the key.
  const resultsKey = libraryResultsKey(filters);
  const { filtered, uncheckedServiceCount } = useMemo(() => {
    const { type, status, language, tag, genre, rating, sort, onlyUnmatched, onlyOnServices } =
      JSON.parse(resultsKey) as LibraryResultCriteria;
    const q = fold(deferredQuery.trim());
    const list: LibraryItem[] = [];
    let unchecked = 0;
    for (const it of items) {
      if (type !== "all" && it.mediaType !== type) continue;
      if (status !== "all" && it.status !== status) continue;
      if (language !== "all" && it.language !== language) continue;
      if (tag !== "all" && !it.tags.includes(tag)) continue;
      if (genre !== "all" && !it.genres.includes(genre)) continue;
      if (rating === "unrated" && it.rating != null) continue;
      if (rating !== "all" && rating !== "unrated") {
        if (it.rating == null || it.rating < Number(rating)) continue;
      }
      if (onlyUnmatched && it.tmdbId != null) continue;
      if (q && !(searchIndex.get(it.id) ?? fold(it.name)).includes(q)) continue;
      if (onlyOnServices) {
        const availability = serviceAvailabilityState(it, accountRegion, myProviderIds);
        if (availability === "UNCHECKED") unchecked++;
        if (availability !== "MATCH") continue;
      }
      list.push(it);
    }
    list.sort((a, b) => {
      switch (sort) {
        case "name":
          return a.name.localeCompare(b.name);
        case "release":
          return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
        case "myrating":
          return (b.rating ?? -1) - (a.rating ?? -1);
        case "tmdb":
          return (b.tmdbRating ?? -1) - (a.tmdbRating ?? -1);
        case "watched":
          return (b.watchedAt ?? "").localeCompare(a.watchedAt ?? "");
        case "added":
        default:
          return b.createdAt.localeCompare(a.createdAt);
      }
    });
    return { filtered: list, uncheckedServiceCount: unchecked };
  }, [items, searchIndex, deferredQuery, resultsKey, myProviderIds, accountRegion]);

  // The brief intentionally defines staleness from the newest cached result:
  // if even that row is older than a week, the whole visible answer is old.
  const staleServiceDataAt = useMemo(() => {
    if (!onlyOnServices || filtered.length === 0) return null;
    let newest: string | null = null;
    for (const item of filtered) {
      if (
        item.providersSyncedAt &&
        (newest === null || item.providersSyncedAt > newest)
      ) {
        newest = item.providersSyncedAt;
      }
    }
    if (!newest) return "not refreshed yet";
    if (newest < providerStaleBefore) {
      return `last refreshed ${fullDate(newest)}`;
    }
    return null;
  }, [filtered, onlyOnServices, providerStaleBefore]);

  // The authoritative selection for actions: visible AND selected, in view order.
  // Deriving the intersection here (instead of pruning `selected` in an effect)
  // means bulk actions still can never touch hidden titles, while a title that's
  // filtered away and back keeps its checkmark.
  const selectedIds = useMemo(
    () => filtered.filter((f) => selected.has(f.id)).map((f) => f.id),
    [filtered, selected],
  );

  // Escape leaves select mode, unless a dialog or the command palette is open
  // (let those handle Escape first so we don't also drop the selection).
  useEffect(() => {
    if (!selectMode) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      setSelectMode(false);
      setSelected(new Set());
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectMode]);

  // While the advanced-filters disclosure is open, Escape closes it and returns
  // focus to the trigger. The panel is an inline region (not a modal), so focus
  // is never trapped and Tab moves through it and back out normally.
  useEffect(() => {
    if (!showFilters) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setShowFilters(false);
      filtersTriggerRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFilters]);

  // "/" focuses the search field (the same convention as GitHub, Linear, etc).
  // Ignored while a modifier is held (so browser/OS shortcuts using "/" still
  // work), while typing anywhere text can already go, and while a dialog or the
  // command palette is open — both render a Radix dialog (`[role="dialog"]`),
  // the same signal the Escape handlers above already check — otherwise the
  // keystroke would steal focus out from under whatever currently has it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
      )
        return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      // Stop the "/" itself from landing in the field it's about to focus.
      e.preventDefault();
      searchInputRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Return to the library automatically once Trash empties (e.g. the last title
  // was restored or purged), so the user isn't stranded on an empty Trash view.
  // Adjusted during render (not in an effect) per React's "adjusting state when a
  // prop changes" pattern: avoids the extra commit-then-effect-then-re-render pass
  // a useEffect here would trigger on every restore/purge.
  if (trashedCount !== reconciledTrashedCount) {
    setReconciledTrashedCount(trashedCount);
    if (trashMode && trashedCount === 0) setTrashMode(false);
  }

  // useCallback so React.memo(TitleCard) holds and search-as-you-type doesn't
  // re-render every card (item refs are already stable from `items`).
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function openShare(ids: string[]) {
    shareOpener.current = (document.activeElement as HTMLElement) ?? null;
    setShareIds(ids);
    setShareMounted(true);
    setShareOpen(true);
  }

  // Pick something random to watch from the current view, preferring titles
  // still on the watchlist (the point is "what should I watch next").
  function surprise() {
    const pool = filtered.filter((it) => it.status === "WATCHLIST");
    const from = pool.length > 0 ? pool : filtered;
    if (from.length === 0) {
      toast.error("Nothing to pick from with these filters.");
      return;
    }
    const pick = from[Math.floor(Math.random() * from.length)];
    toast.success(`Tonight: ${pick.name}`);
    router.push(`/title/${pick.id}`);
  }

  if (trashMode) {
    return <TrashView trashed={trashed} onExit={() => setTrashMode(false)} />;
  }

  // First run: nothing to filter, select or view, so the filter and utility
  // rows would be clutter (JK-31). With titles in Trash the rows stay, since
  // Trash is reached through the Filters panel.
  const firstRun = items.length === 0 && trashedCount === 0;

  return (
    <LibraryFiltersContext
      value={{
        state: filters,
        actions: { set: setFilters, clear: () => dispatchFilters({ type: "clear" }) },
        meta: { languages, genres, tags },
      }}
    >
      <div className="flex flex-col gap-5 pb-24">
        {/* Toolbar */}
        <div className="flex flex-col gap-4">
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>

          <LibrarySearchRow searchInputRef={searchInputRef} filtered={filtered} items={items} />

          <LibraryFilterRow
            firstRun={firstRun}
            myProviders={myProviders}
            showFilters={showFilters}
            onToggleFilters={() => setShowFilters((v) => !v)}
            filtersTriggerRef={filtersTriggerRef}
          />

          {/* The Filters button is hidden on a first run, and the search isn't. */}
          <LibraryFilterChips fallbackFocusRef={firstRun ? searchInputRef : filtersTriggerRef} />

          <LibraryFilterPanel
            showFilters={showFilters}
            trashedCount={trashedCount}
            onOpenTrash={() => setTrashMode(true)}
          />

          {/* Row 3 — utilities: de-emphasized selection, discovery, and view
              controls, right-aligned in one compact cluster. */}
          <div className={cn("flex flex-wrap items-center justify-end gap-2", firstRun && "hidden")}>
            <button
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              aria-label="Select titles"
              aria-pressed={selectMode}
              title="Select titles"
              className={cn(
                "focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 press sm:min-h-8 sm:min-w-0 sm:justify-start",
                selectMode
                  ? "bg-brand/15 text-brand ring-brand/40"
                  : "text-muted ring-line hover:text-foreground",
              )}
            >
              <CheckSquare size={16} />
              <span className="hidden sm:inline">Select</span>
            </button>
            {!selectMode && items.length > 0 && (
              <>
                {/* Nothing to pick from an empty view (JK-31). */}
                {filtered.length > 0 && (
                  <button
                    onClick={surprise}
                    title="Pick something random to watch (prefers your watchlist)"
                    aria-label="Surprise me"
                    className="focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line press hover:text-foreground sm:min-h-8 sm:min-w-0 sm:justify-start"
                  >
                    <Dices size={16} />
                    <span className="hidden sm:inline">Surprise</span>
                  </button>
                )}
                <button
                  onClick={() => openShare([])}
                  title="Share your library"
                  aria-label="Share your library"
                  className="focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line press hover:text-foreground sm:min-h-8 sm:min-w-0 sm:justify-start"
                >
                  <Share2 size={16} />
                  <span className="hidden sm:inline">Share</span>
                </button>
              </>
            )}
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line">
              <ViewToggle
                active={view === "grid"}
                onClick={() => setFilters({ view: "grid" })}
                label="Grid view"
              >
                <LayoutGrid size={16} />
              </ViewToggle>
              <ViewToggle
                active={view === "list"}
                onClick={() => setFilters({ view: "list" })}
                label="List view"
              >
                <List size={16} />
              </ViewToggle>
            </div>
          </div>

          {selectMode && filtered.length > 0 && (
            <div className="flex justify-end">
              <button
                onClick={() =>
                  setSelected(
                    selectedIds.length === filtered.length
                      ? new Set()
                      : new Set(filtered.map((f) => f.id)),
                  )
                }
                className="focus-ring flex min-h-11 items-center px-2 sm:min-h-0 rounded text-xs font-medium text-brand hover:underline"
              >
                {selectedIds.length === filtered.length ? "Deselect all" : "Select all"}
              </button>
            </div>
          )}
        </div>

        {onlyOnServices && filtered.length > 0 ? (
          <p className="-mt-2 text-xs text-faint">
            Availability in {regionName(accountRegion)} via JustWatch
            {uncheckedServiceCount > 0
              ? ` · ${uncheckedProviderCopy(uncheckedServiceCount)}`
              : ""}
            {staleServiceDataAt ? ` · ${staleServiceDataAt}` : ""}
          </p>
        ) : null}

        {/* Results */}
        <LibraryResults
          filtered={filtered}
          items={items}
          tagColors={tagColors}
          selectMode={selectMode}
          selected={selected}
          onToggle={toggle}
          myProviders={myProviders}
          accountRegion={accountRegion}
          uncheckedServiceCount={uncheckedServiceCount}
        />

        {/* Bulk action bar — only when there's something selected */}
        <BulkBar
          open={selectMode && selectedIds.length > 0}
          count={selectedIds.length}
          ids={selectedIds}
          tags={tags}
          onShare={() => openShare(selectedIds)}
          onDone={exitSelect}
        />

        {shareMounted && (
          <ShareDialog
            open={shareOpen}
            onClose={() => setShareOpen(false)}
            titleIds={shareIds}
            count={shareIds.length}
            opener={shareOpener}
          />
        )}
      </div>
    </LibraryFiltersContext>
  );
}

function ViewToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "focus-ring flex h-11 w-11 items-center justify-center rounded-md press sm:h-7 sm:w-7",
        active ? "bg-surface text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
