"use client";

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import {
  filtersToParams,
  type LibraryFilters,
  type SortKey,
  type TypeFilter,
} from "@/lib/library-filters";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  CheckSquare,
  ChevronDown,
  Clapperboard,
  Dices,
  Download,
  Heart,
  LayoutGrid,
  List,
  Minus,
  Plus,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { LibraryItem, TrashedTitle } from "@/lib/data";
import type { WatchStatus } from "@/generated/prisma/client";
import { Badge, Button, Card, Input, Select } from "./ui";
import { TitleCard } from "./title-card";
import { Poster } from "./poster";
import { ShareDialog } from "./share-dialog";
import { useConfirm } from "./confirm-dialog";
import {
  AnimatePresence,
  EASE_OUT,
  motion,
  useReducedMotion,
} from "./motion";
import { STATUS_META, STATUS_ORDER, fullDate, languageName, progressPct } from "@/lib/format";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkRemoveTitles,
  bulkSetFavorite,
  bulkSetStatus,
  emptyTrash,
  purgeTitle,
  restoreTitle,
} from "@/lib/actions";
import { tagChipClass } from "@/lib/tag-colors";
import { regionName } from "@/lib/tmdb-extras";
import { undoToast } from "@/lib/undo-toast";
import { cn } from "@/lib/utils";
import {
  encodeLibraryRememberedState,
  REMEMBERED_COOKIE_NAMES,
  writeRememberedCookie,
} from "@/lib/remembered-state-client";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "watched", label: "Recently watched" },
  { key: "name", label: "Name (A-Z)" },
  { key: "release", label: "Release (newest)" },
  { key: "myrating", label: "Your rating" },
  { key: "tmdb", label: "TMDB rating" },
];

// Segmented quick-filter options, wired to the same `type` state (and URL param)
// the advanced-panel <Select> used to drive.
const TYPE_OPTIONS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "MOVIE", label: "Movies" },
  { value: "TV", label: "TV shows" },
];

// Primary CTA rendered as a real anchor (Link to /add). Mirrors
// <Button variant="primary" size="md"> from ui.tsx — that primitive can't take
// an href, and ui.tsx is out of this task's scope, so its classes are inlined.
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

export function uncheckedProviderCopy(count: number): string {
  return `${count} ${count === 1 ? "title" : "titles"} not checked yet`;
}

/**
 * The filter state a URL encodes, as one comparable string. `Library` adopts an
 * incoming `initialFilters` only when this key differs from the one the last
 * prop carried, which is what keeps a re-render from being mistaken for a
 * navigation.
 */
export function libraryFilterKey(filters: LibraryFilters): string {
  return filtersToParams(filters).toString();
}

const addTitleButtonClass =
  "inline-flex min-h-11 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-lg brand-gradient px-4 text-sm font-semibold text-[#04121c] shadow-sm shadow-brand/20 transition-colors hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 sm:min-h-10";

// Chrome moves focus to <body> the instant a focused control becomes
// `disabled`, so every bulk and Trash action left the keyboard back at the skip
// link. Those controls carry `aria-disabled` and return early instead, and
// these classes reproduce the `disabled:` styling ui.tsx applies through the
// native attribute.
const softDisabledClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

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
  const reduceMotion = useReducedMotion();
  // Trash is a distinct mode that replaces the whole toolbar + grid; entered from
  // the Filters panel, exited via "Back to library". trashedCount drives the entry.
  const [trashMode, setTrashMode] = useState(false);
  const trashedCount = trashed.length;
  // Tracks the trashedCount last reconciled against trashMode, so the render-time
  // adjustment below (React's "adjusting state when a prop changes" pattern) runs
  // its setState exactly once per actual count change instead of looping.
  const [reconciledTrashedCount, setReconciledTrashedCount] = useState(trashedCount);
  const [query, setQuery] = useState(initialFilters.query);
  const [type, setType] = useState<TypeFilter>(initialFilters.type);
  const [status, setStatus] = useState<WatchStatus | "all">(initialFilters.status);
  const [language, setLanguage] = useState<string>(initialFilters.language);
  const [tag, setTag] = useState<string>(initialFilters.tag);
  const [genre, setGenre] = useState<string>(initialFilters.genre);
  const [rating, setRating] = useState<string>(initialFilters.rating);
  const [sort, setSort] = useState<SortKey>(initialFilters.sort);
  const [view, setView] = useState<"grid" | "list">(initialFilters.view);
  const [onlyUnmatched, setOnlyUnmatched] = useState(initialFilters.onlyUnmatched);
  const [onlyOnServices, setOnlyOnServices] = useState(
    initialFilters.onlyOnServices ?? false,
  );
  // The filters the server last handed down, so a genuinely new set can be told
  // from the same set arriving again.
  const [appliedFilterKey, setAppliedFilterKey] = useState(() =>
    libraryFilterKey(initialFilters),
  );

  // Adopt the server's filters when they actually change, adjusted during
  // render (React's "adjusting state when a prop changes" pattern, the same one
  // the Trash count uses below). <Library> used to be keyed on these filters
  // instead: once any filter had been changed, the router.refresh() that ends
  // every bulk and Trash action re-rendered the page from the params this
  // component had itself mirrored with replaceState, the key changed, and the
  // remount threw away select mode, the selection, the open filters panel and
  // Trash mode. That refresh now lands here with a key the last prop already
  // carried, or with the mirrored one whose setters are all no-ops, while
  // back/forward navigation still re-applies its URL.
  const incomingFilterKey = libraryFilterKey(initialFilters);
  if (incomingFilterKey !== appliedFilterKey) {
    setAppliedFilterKey(incomingFilterKey);
    setQuery(initialFilters.query);
    setType(initialFilters.type);
    setStatus(initialFilters.status);
    setLanguage(initialFilters.language);
    setTag(initialFilters.tag);
    setGenre(initialFilters.genre);
    setRating(initialFilters.rating);
    setSort(initialFilters.sort);
    setView(initialFilters.view);
    setOnlyUnmatched(initialFilters.onlyUnmatched);
    setOnlyOnServices(initialFilters.onlyOnServices ?? false);
  }

  // The single advanced-filters disclosure (all widths); collapsed by default.
  const [showFilters, setShowFilters] = useState(false);

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [shareIds, setShareIds] = useState<string[]>([]);
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
  // briefly on screen; every mirror after that is debounced. The cookie write
  // is additionally skipped when its encoded value hasn't changed since the
  // last write (mirrorLastCookieRef) — the cookie doesn't even carry `query`
  // (see LibraryRememberedState), so same-query keystrokes were writing an
  // identical value on every call.
  const mirrorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mirrorIsFirstRunRef = useRef(true);
  const mirrorLastCookieRef = useRef<string | null | undefined>(undefined);
  // Holds the latest pending mirror so the unmount-flush effect below can run
  // it directly instead of re-deriving filter state from scratch.
  const mirrorPendingRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const currentFilters: LibraryFilters = {
      query: query.trim(),
      type,
      status,
      language,
      tag,
      genre,
      rating: rating as LibraryFilters["rating"],
      sort,
      view,
      onlyUnmatched,
      onlyOnServices,
    };

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

    if (mirrorIsFirstRunRef.current) {
      mirrorIsFirstRunRef.current = false;
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
  }, [
    query,
    type,
    status,
    language,
    tag,
    genre,
    rating,
    sort,
    view,
    onlyUnmatched,
    onlyOnServices,
    rememberFilters,
  ]);

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

  const hasFilters =
    query !== "" ||
    type !== "all" ||
    status !== "all" ||
    language !== "all" ||
    tag !== "all" ||
    genre !== "all" ||
    rating !== "all" ||
    onlyUnmatched ||
    onlyOnServices;

  // Active advanced facets, one removable chip each. Excludes type (its own
  // quick-filter) and sort (ordering, not a filter), so the chip set and the
  // disclosure badge count stay in step with what actually narrows the results.
  const facetChips: { key: string; label: string; clear: () => void }[] = [];
  if (status !== "all")
    facetChips.push({
      key: "status",
      label: `Status: ${STATUS_META[status].label}`,
      clear: () => setStatus("all"),
    });
  if (language !== "all")
    facetChips.push({
      key: "language",
      label: `Language: ${languageName(language)}`,
      clear: () => setLanguage("all"),
    });
  if (genre !== "all")
    facetChips.push({ key: "genre", label: `Genre: ${genre}`, clear: () => setGenre("all") });
  if (rating !== "all")
    facetChips.push({
      key: "rating",
      label: rating === "unrated" ? "Rating: Unrated" : `Rating: ${rating}+`,
      clear: () => setRating("all"),
    });
  if (tag !== "all")
    facetChips.push({ key: "tag", label: `Tag: ${tag}`, clear: () => setTag("all") });
  if (onlyUnmatched)
    facetChips.push({
      key: "unmatched",
      label: "Needs match",
      clear: () => setOnlyUnmatched(false),
    });
  const advancedCount = facetChips.length;

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

  const { filtered, uncheckedServiceCount } = useMemo(() => {
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
  }, [
    items,
    searchIndex,
    deferredQuery,
    type,
    status,
    language,
    tag,
    genre,
    rating,
    sort,
    onlyUnmatched,
    onlyOnServices,
    myProviderIds,
    accountRegion,
  ]);

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

  function clearFilters() {
    setQuery("");
    setType("all");
    setStatus("all");
    setLanguage("all");
    setTag("all");
    setGenre("all");
    setRating("all");
    setOnlyUnmatched(false);
    setOnlyOnServices(false);
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

  // Deep link to /export with the current filters pre-applied (query and the
  // needs-match toggle have no export equivalent; sort doesn't affect content).
  const exportHref = useMemo(() => {
    const p = new URLSearchParams();
    if (type !== "all") p.set("type", type === "MOVIE" ? "movie" : "tv");
    if (status !== "all") p.set("status", status);
    if (tag !== "all") p.set("tag", tag);
    if (genre !== "all") p.set("genre", genre);
    if (language !== "all") p.set("lang", language);
    if (rating !== "all" && rating !== "unrated") p.set("min", rating);
    const qs = p.toString();
    return qs ? `/export?${qs}` : "/export";
  }, [type, status, tag, genre, language, rating]);

  if (trashMode) {
    return <TrashView trashed={trashed} onExit={() => setTrashMode(false)} />;
  }

  return (
    <div className="flex flex-col gap-5 pb-24">
      {/* Toolbar */}
      <div className="flex flex-col gap-4">
        <h1 className="text-xl font-semibold tracking-tight">Library</h1>

        {/* Row 1 — primary: the search is the dominant utility, next to a live
            result count and the one high-emphasis action (Add title). */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative order-last w-full min-w-0 sm:order-none sm:w-auto sm:max-w-md sm:flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              ref={searchInputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
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
              {filtered.length} {filtered.length === 1 ? "title" : "titles"}
              {hasFilters ? ` of ${items.length}` : ""}
            </p>
            <Link href="/add" className={addTitleButtonClass}>
              <Plus size={16} /> Add title
            </Link>
          </div>
        </div>

        {/* Row 2 — contextual: a type quick-filter and the single entry point to
            the advanced facets, on every width. */}
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Filter by type"
            className="inline-flex items-center gap-0.5 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line"
          >
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setType(opt.value)}
                aria-pressed={type === opt.value}
                className={cn(
                  "focus-ring flex min-h-11 items-center justify-center rounded-md px-3 text-sm transition-colors sm:min-h-8",
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
            onClick={() => setOnlyOnServices((value) => !value)}
            aria-pressed={onlyOnServices}
            title={
              myProviders.length > 0
                ? `Show titles available on your ${myProviders.length} selected ${myProviders.length === 1 ? "service" : "services"}`
                : "Choose your services in Settings"
            }
            className={cn(
              "focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm ring-1 transition-colors sm:min-h-8",
              onlyOnServices
                ? "bg-brand/15 text-brand ring-brand/40"
                : "text-muted ring-line hover:text-foreground",
            )}
          >
            <Clapperboard aria-hidden="true" size={15} />
            On my services
          </button>
          <button
            ref={filtersTriggerRef}
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            aria-controls="library-advanced-filters"
            aria-label={advancedCount > 0 ? `Filters, ${advancedCount} active` : "Filters"}
            className={cn(
              "focus-ring ml-auto flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm ring-1 transition-colors sm:min-h-8",
              showFilters || advancedCount > 0
                ? "bg-surface-2 text-foreground ring-line-strong"
                : "text-muted ring-line hover:text-foreground",
            )}
          >
            <SlidersHorizontal size={15} />
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

        {/* Active-filter chips — one removable chip per active facet, shown
            whether or not the advanced panel is open. */}
        {facetChips.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {facetChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.clear}
                aria-label={`Remove ${chip.label} filter`}
                className="focus-ring flex min-h-11 min-w-0 items-center gap-1.5 rounded-full bg-surface-2 px-3 text-xs text-foreground ring-1 ring-line transition-colors hover:text-foreground sm:min-h-0 sm:py-1"
              >
                <span className="break-words">{chip.label}</span>
                <X size={13} aria-hidden className="text-muted" />
              </button>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="focus-ring flex min-h-11 items-center rounded-lg px-2 text-xs font-medium text-muted transition-colors hover:text-foreground sm:min-h-0"
            >
              Clear all
            </button>
          </div>
        )}

        {/* Advanced filters — collapsed by default; the only entry point is the
            Row 2 disclosure button. Inline region, so focus is never trapped. */}
        <AnimatePresence>
          {showFilters && (
            <motion.div
              key="advanced-filters"
              id="library-advanced-filters"
              // The reveal is CSS (collapse-in), so the open panel is visible
              // even if Motion's features never load; Motion only runs the exit
              // (and a reopen mid-exit). Without features it unmounts at once,
              // so a closed panel is never focusable. -mt-4 here and mt-4 on
              // the Card cancel the parent's gap-4, so the collapsed panel
              // takes no space and the gap never jumps.
              initial={false}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: EASE_OUT }}
              className="-mt-4 grid grid-rows-[1fr] overflow-hidden motion-safe:animate-[collapse-in_200ms_cubic-bezier(0.16,1,0.3,1)]"
            >
              <div className="min-h-0">
              <Card variant="inset" className="mt-4 flex flex-col gap-3 p-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <Select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as WatchStatus | "all")}
                    aria-label="Filter by status"
                    className="w-full"
                  >
                    <option value="all">Any status</option>
                    {STATUS_ORDER.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_META[s].label}
                      </option>
                    ))}
                  </Select>
                  {languages.length > 1 && (
                    <Select
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      aria-label="Filter by language"
                      className="w-full"
                    >
                      <option value="all">Any language</option>
                      {languages.map((l) => (
                        <option key={l} value={l}>
                          {languageName(l)}
                        </option>
                      ))}
                    </Select>
                  )}
                  {genres.length > 1 && (
                    <Select
                      value={genre}
                      onChange={(e) => setGenre(e.target.value)}
                      aria-label="Filter by genre"
                      className="w-full"
                    >
                      <option value="all">Any genre</option>
                      {genres.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </Select>
                  )}
                  <Select
                    value={rating}
                    onChange={(e) => setRating(e.target.value)}
                    aria-label="Filter by rating"
                    className="w-full"
                  >
                    <option value="all">Any rating</option>
                    <option value="unrated">Unrated</option>
                    <option value="9">9+</option>
                    <option value="8">8+</option>
                    <option value="7">7+</option>
                    <option value="6">6+</option>
                    <option value="5">5+</option>
                  </Select>
                  {tags.length > 0 && (
                    <Select
                      value={tag}
                      onChange={(e) => setTag(e.target.value)}
                      aria-label="Filter by tag"
                      className="w-full"
                    >
                      <option value="all">Any tag</option>
                      {tags.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  )}
                  <Select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SortKey)}
                    aria-label="Sort titles"
                    className="w-full"
                  >
                    {SORTS.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                  <button
                    type="button"
                    onClick={() => setOnlyUnmatched((v) => !v)}
                    title="Show titles with no TMDB match"
                    aria-pressed={onlyUnmatched}
                    className={cn(
                      "focus-ring flex min-h-11 w-full items-center justify-center rounded-lg px-2.5 text-sm ring-1 transition-colors sm:min-h-9",
                      onlyUnmatched
                        ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
                        : "text-muted ring-line hover:text-foreground",
                    )}
                  >
                    Needs match
                  </button>
                </div>
                {(trashedCount > 0 || (hasFilters && !onlyOnServices)) && (
                  <div className="flex items-center justify-between gap-2 border-t border-line pt-3">
                    {trashedCount > 0 ? (
                      <button
                        type="button"
                        onClick={() => setTrashMode(true)}
                        className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted transition-colors hover:text-foreground sm:min-h-0"
                      >
                        <Trash2 size={14} /> Trash ({trashedCount})
                      </button>
                    ) : (
                      <span />
                    )}
                    {hasFilters && !onlyOnServices && (
                      <Link
                        href={exportHref}
                        title="Open Export with these filters applied"
                        className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted transition-colors hover:text-foreground sm:min-h-0"
                      >
                        <Download size={14} /> Export these
                      </Link>
                    )}
                  </div>
                )}
              </Card>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Row 3 — utilities: de-emphasized selection, discovery, and view
            controls, right-aligned in one compact cluster. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
            aria-label="Select titles"
            aria-pressed={selectMode}
            title="Select titles"
            className={cn(
              "focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 transition-colors sm:min-h-8 sm:min-w-0 sm:justify-start",
              selectMode
                ? "bg-brand/15 text-brand ring-brand/40"
                : "text-muted ring-line hover:text-foreground",
            )}
          >
            <CheckSquare size={15} />
            <span className="hidden sm:inline">Select</span>
          </button>
          {!selectMode && items.length > 0 && (
            <>
              <button
                onClick={surprise}
                title="Pick something random to watch (prefers your watchlist)"
                aria-label="Surprise me"
                className="focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-8 sm:min-w-0 sm:justify-start"
              >
                <Dices size={15} />
                <span className="hidden sm:inline">Surprise</span>
              </button>
              <button
                onClick={() => openShare([])}
                title="Share your library"
                aria-label="Share your library"
                className="focus-ring flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-8 sm:min-w-0 sm:justify-start"
              >
                <Share2 size={15} />
                <span className="hidden sm:inline">Share</span>
              </button>
            </>
          )}
          <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line">
            <ViewToggle
              active={view === "grid"}
              onClick={() => setView("grid")}
              label="Grid view"
            >
              <LayoutGrid size={16} />
            </ViewToggle>
            <ViewToggle
              active={view === "list"}
              onClick={() => setView("list")}
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
      {filtered.length === 0 ? (
        <EmptyState
          hasItems={items.length > 0}
          onClear={clearFilters}
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
              onToggle={toggle}
              // LCP: only the first few above-the-fold cards get eager/priority loading.
              priority={i < 4}
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
              onToggle={toggle}
            />
          ))}
        </div>
      )}

      {/* Bulk action bar — only when there's something selected */}
      <BulkBar
        open={selectMode && selectedIds.length > 0}
        count={selectedIds.length}
        ids={selectedIds}
        tags={tags}
        onShare={() => openShare(selectedIds)}
        onDone={exitSelect}
      />

      <ShareDialog
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        titleIds={shareIds}
        count={shareIds.length}
        opener={shareOpener}
      />
    </div>
  );
}

function BulkBar({
  open,
  count,
  ids,
  tags,
  onShare,
  onDone,
}: {
  open: boolean;
  count: number;
  ids: string[];
  tags: string[];
  onShare: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newTag, setNewTag] = useState("");
  const [bulkStatus, setBulkStatus] = useState<WatchStatus | "">("");
  // Phone-width disclosure for the secondary actions. The bar used to pack
  // every control into one line: below sm it wrapped to four or five rows and
  // swallowed ~40% of the viewport, and from sm to lg the nowrap scroller cut
  // off everything past the fold — including Remove and Done, because `ml-auto`
  // resolves to zero inside an overflowing flex container, so the exit and the
  // destructive action were both off-screen with nothing to hint at a scroll.
  // Now the bar wraps at every width (no scroller), and on phones only the
  // count, the status select, Remove and Done stay out; the rest lives here.
  const [showMore, setShowMore] = useState(false);
  // Tracks the `open` value last reconciled against showMore, so the
  // render-time adjustment below runs once per actual change (same pattern the
  // Trash count uses above) rather than looping.
  const [reconciledOpen, setReconciledOpen] = useState(open);
  const { confirm, dialog } = useConfirm();
  const disabled = pending || count === 0;

  // Leaving select mode closes the disclosure, so the next selection starts from
  // the same compact bar rather than whatever the last one was left expanded to.
  if (open !== reconciledOpen) {
    setReconciledOpen(open);
    if (!open) {
      setShowMore(false);
      setBulkStatus("");
    }
  }

  // On a phone the toast sits 4.5rem from the bottom, which is exactly over this
  // bar's first row for its whole four seconds. Publishing the bar's measured
  // height (the More disclosure changes it) lets the Toaster in (app)/layout.tsx
  // clear it while it is open and fall back to its own offset once it is gone.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!open || !bar) return;
    const root = document.documentElement;
    const sync = () =>
      root.style.setProperty(
        "--toast-bottom",
        `${Math.ceil(bar.getBoundingClientRect().height) + 8}px`,
      );
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--toast-bottom");
    };
  }, [open]);

  function run(
    fn: () => Promise<{ count?: number; tag?: string; error?: string }>,
    verb: string,
  ) {
    start(async () => {
      try {
        const res = await fn();
        if (res.error) {
          toast.error(res.error);
          return;
        }
        const changed = res.count ?? 0;
        toast.success(`${verb} ${changed} ${changed === 1 ? "title" : "titles"}`);
      } catch {
        toast.error("Couldn't update those titles. Try again.");
      } finally {
        // Always re-sync to the server so a partial failure can't leave stale UI.
        router.refresh();
      }
    });
  }

  function removeSelected() {
    // Capture the exact selection before leaving select mode; the toast action
    // outlives this bar and must not read whatever ids a later selection holds.
    const removedIds = [...ids];
    start(async () => {
      try {
        const res = await bulkRemoveTitles(removedIds);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        const removedCount = res.count ?? 0;
        onDone();
        undoToast(`Removed ${removedCount} ${removedCount === 1 ? "title" : "titles"}`, {
          undo: async () => {
            // Bound the server-action fan-out for a large selection. Each
            // restore is ownership-scoped and safely no-ops if a row was
            // already restored through Trash in another tab.
            for (let index = 0; index < removedIds.length; index += 6) {
              const results = await Promise.all(
                removedIds.slice(index, index + 6).map((id) => restoreTitle(id)),
              );
              const error = results.find((result) => result.error)?.error;
              if (error) return { error };
            }
            return {};
          },
          success: `Restored ${removedCount} ${removedCount === 1 ? "title" : "titles"}`,
          failure: "Couldn't restore every title. Check Trash and retry.",
          onError: () => router.refresh(),
        });
      } catch {
        toast.error("Couldn't remove those titles. Try again.");
      } finally {
        router.refresh();
      }
    });
  }

  function applyBulkStatus() {
    if (disabled || !bulkStatus) return;
    const status = bulkStatus;
    run(async () => {
      const result = await bulkSetStatus(ids, status);
      if (!result.error) setBulkStatus("");
      return result;
    }, "Updated");
  }

  return (
    <>
      {dialog}
      <AnimatePresence>
      {open && (
        <motion.div
          ref={barRef}
          // z-[45]: above the mobile tab bar (nav.tsx, z-40, md:hidden) — selection
          // mode is a transient modal-ish state that's meant to cover it — but
          // below dialogs/command palette (z-50) so a confirm dialog or the share
          // dialog opened from here still renders on top.
          className="fixed inset-x-0 bottom-0 z-[45] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          {/* max-w-5xl (was 4xl): the full control set measures ~930px, so the
              wider cap is what lets a desktop still show it on a single row. */}
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 rounded-2xl bg-surface/95 p-2.5 shadow-xl ring-1 ring-line backdrop-blur-md">
            <span className="shrink-0 px-2 text-sm font-medium tabular-nums">
              {count} selected
            </span>

            <Select
              value={bulkStatus}
              aria-disabled={disabled}
              onChange={(e) => {
                // aria-disabled doesn't stop a native select from changing, so
                // guard here (the controlled value then snaps back).
                if (disabled) return;
                setBulkStatus(e.target.value as WatchStatus | "");
              }}
              aria-label="Set status for selected titles"
              className={cn("w-auto min-h-11 shrink-0", softDisabledClass)}
            >
              <option value="">Set status…</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-disabled={disabled || !bulkStatus}
              onClick={applyBulkStatus}
              className={cn("min-h-11 shrink-0", softDisabledClass)}
            >
              Apply
            </Button>

            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              aria-controls="bulk-more-actions"
              className="focus-ring flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:hidden"
            >
              More
              <ChevronDown
                size={14}
                aria-hidden
                className={cn("transition-transform", showMore && "rotate-180")}
              />
            </button>

            {/* Secondary actions. Below sm this is the disclosure: a full-width
                row that wraps directly under the More button controlling it. It
                used to be pulled below Remove/Done with `order-last` so those two
                never moved, but that left tab order and screen-reader order
                disagreeing with the screen — the panel was read before the two
                buttons it appeared underneath. Sitting next to its trigger costs
                Remove/Done one row while the panel is open, and is where a
                disclosure's content belongs anyway. Rules on both edges keep it
                legible as its own block between the two rows. From sm up the
                breakpoint utilities win outright, so it sits inline whatever the
                disclosure was last left at. */}
            <div
              id="bulk-more-actions"
              className={cn(
                "w-full flex-wrap items-center gap-2 border-y border-line py-2.5 sm:w-auto sm:border-0 sm:py-0",
                showMore ? "flex" : "hidden sm:flex",
              )}
            >
              <div className="flex items-center gap-1">
                <Input
                  list="bulk-tags"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="Add tag…"
                  aria-disabled={disabled}
                  aria-label="Tag to add or remove"
                  className={cn("h-9 min-h-11 w-32 sm:min-h-0", softDisabledClass)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !disabled && newTag.trim()) {
                      run(() => bulkAddTag(ids, newTag.trim()), "Tagged");
                      setNewTag("");
                    }
                  }}
                />
                <datalist id="bulk-tags">
                  {tags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={disabled || !newTag.trim()}
                  onClick={() => {
                    if (disabled || !newTag.trim()) return;
                    run(() => bulkAddTag(ids, newTag.trim()), "Tagged");
                    setNewTag("");
                  }}
                  title="Add this tag to selected"
                  aria-label="Add this tag to selected"
                  className={cn("min-h-11 min-w-11 sm:min-w-0", softDisabledClass)}
                >
                  <TagIcon size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={disabled || !newTag.trim()}
                  onClick={() => {
                    if (disabled || !newTag.trim()) return;
                    run(() => bulkRemoveTag(ids, newTag.trim()), "Untagged");
                    setNewTag("");
                  }}
                  title="Remove this tag from selected"
                  aria-label="Remove this tag from selected"
                  className={cn("min-h-11 min-w-11 sm:min-w-0", softDisabledClass)}
                >
                  <Minus size={14} />
                </Button>
              </div>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  run(() => bulkSetFavorite(ids, true), "Favorited");
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Heart size={14} /> Favorite
              </Button>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  run(() => bulkSetFavorite(ids, false), "Unfavorited");
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Heart size={14} className="text-faint" /> Unfavorite
              </Button>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onShare();
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Share2 size={14} /> Share
              </Button>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                aria-disabled={disabled}
                onClick={async () => {
                  if (disabled) return;
                  if (
                    !(await confirm({
                      title: `Remove ${count} ${count === 1 ? "title" : "titles"}?`,
                      body:
                        count === 1
                          ? "This moves it to Trash. You can restore it from there."
                          : "This moves them to Trash. You can restore them from there.",
                      confirmLabel: "Remove",
                      destructive: true,
                    }))
                  )
                    return;
                  removeSelected();
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Trash2 size={14} /> Remove
              </Button>

              <button
                onClick={onDone}
                className="focus-ring flex min-h-11 items-center rounded-lg px-2.5 py-1.5 text-sm text-muted hover:text-foreground sm:min-h-8"
              >
                Done
              </button>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </>
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
        "focus-ring flex h-11 w-11 items-center justify-center rounded-md transition-colors sm:h-7 sm:w-7",
        active ? "bg-surface text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

/** Tags shown inline on a row before the rest collapse into a "+n" count. */
const ROW_TAG_LIMIT = 3;

function ListRow({
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
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.favorite && (
            <span>
              <Heart size={12} aria-hidden="true" className="fill-rose-400 text-rose-400" />
              <span className="sr-only">Favorite</span>
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {isTv ? "TV" : "Movie"} · {item.year || "Unknown"}
          {isTv && item.totalEpisodes ? ` · ${item.watchedEpisodes}/${item.totalEpisodes} eps (${pct}%)` : ""}
          {item.language ? ` · ${languageName(item.language)}` : ""}
          {item.rating ? ` · ★ ${item.rating}` : ""}
        </div>
        {shownTags.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {shownTags.map((t) => (
              <span
                key={t}
                className={cn(
                  // inline-block, not inline-flex: `truncate` needs a block
                  // formatting context for its ellipsis to actually render.
                  "inline-block max-w-32 truncate rounded-full px-2 py-0.5 align-middle text-[11px] font-medium ring-1 ring-inset",
                  tagChipClass(tagColors?.[t]),
                )}
              >
                {t}
              </span>
            ))}
            {hiddenTagCount > 0 && (
              <span className="text-[11px] tabular-nums text-faint">
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
          "cv-auto focus-ring flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
          selected ? "bg-brand/10" : "bg-surface hover:bg-surface-2/50",
        )}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded ring-1",
            selected ? "bg-brand text-[#04121c] ring-brand" : "ring-line",
          )}
        >
          {selected && <CheckSquare size={13} />}
        </span>
        {inner}
      </button>
    );
  }

  return (
    <Link
      href={`/title/${item.id}`}
      className="cv-auto focus-ring flex items-center gap-3 bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2/50"
    >
      {inner}
    </Link>
  );
}

function EmptyState({
  hasItems,
  onClear,
  onlyOnServices,
  hasConfiguredProviders,
  accountRegion,
  uncheckedServiceCount,
}: {
  hasItems: boolean;
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
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line py-20 text-center">
      <p className="text-sm text-muted">
        {hasItems ? "No titles match your filters." : "Your library is empty."}
      </p>
      {hasItems ? (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onClear}
            className="focus-ring flex min-h-11 items-center justify-center rounded-lg px-2 py-1.5 text-sm font-medium text-brand hover:underline sm:min-h-0"
          >
            Try clearing filters
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

function TrashView({
  trashed,
  onExit,
}: {
  trashed: TrashedTitle[];
  onExit: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { confirm, dialog } = useConfirm();
  // Restoring or deleting a row unmounts the button that was focused, so focus
  // has to be placed deliberately once the refreshed list arrives: on the row
  // that took its place, or the row above when the last one went. Rows are
  // collected by id because the row that must receive focus is not the one that
  // was clicked. ui.tsx's Button takes no ref, so the row element is what is
  // held and its first control — Restore — is what gets focused.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const focusAfterRemovalId = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRemovalId.current;
    if (!id) return;
    focusAfterRemovalId.current = null;
    rowRefs.current.get(id)?.querySelector("button")?.focus();
  }, [trashed]);

  /** The row focus should land on once `id`'s row is gone. */
  function neighbourRowId(id: string): string | null {
    const index = trashed.findIndex((item) => item.id === id);
    if (index === -1) return null;
    return trashed[index + 1]?.id ?? trashed[index - 1]?.id ?? null;
  }

  function restore(item: TrashedTitle) {
    const neighbour = neighbourRowId(item.id);
    start(async () => {
      try {
        const res = await restoreTitle(item.id);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        focusAfterRemovalId.current = neighbour;
        toast.success(`Restored ${item.name}`);
      } catch {
        toast.error("Couldn't restore that title. Try again.");
      } finally {
        // Re-sync from the server so a failed action can't leave a stale row.
        router.refresh();
      }
    });
  }

  async function purge(item: TrashedTitle) {
    if (
      !(await confirm({
        title: `Delete ${item.name} forever?`,
        body: "This permanently deletes it. No undo.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return;
    const neighbour = neighbourRowId(item.id);
    start(async () => {
      try {
        const res = await purgeTitle(item.id);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        focusAfterRemovalId.current = neighbour;
        toast.success(`Deleted ${item.name}`);
      } catch {
        toast.error("Couldn't delete that title. Try again.");
      } finally {
        router.refresh();
      }
    });
  }

  async function purgeAll() {
    const n = trashed.length;
    if (
      !(await confirm({
        title: `Delete all ${n} ${n === 1 ? "title" : "titles"} forever?`,
        body: "This permanently deletes everything in Trash, with all its ratings, notes and episode progress. No undo.",
        confirmLabel: "Delete all forever",
        destructive: true,
      }))
    )
      return;
    start(async () => {
      try {
        const res = await emptyTrash();
        if (res.error) {
          toast.error(res.error);
          return;
        }
        const deletedCount = res.count ?? 0;
        toast.success(
          `Deleted ${deletedCount} ${deletedCount === 1 ? "title" : "titles"}`,
        );
      } catch {
        toast.error("Couldn't empty Trash. Try again.");
      } finally {
        router.refresh();
      }
    });
  }

  return (
    <>
      {dialog}
      <div className="flex flex-col gap-4 pb-24">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {trashed.length} {trashed.length === 1 ? "title" : "titles"}
            </span>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-8"
          >
            <ArrowLeft size={15} /> Back to library
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Restore a title to bring it back with your ratings and notes, or delete it forever.
          </p>
          {trashed.length > 1 && (
            <Button
              size="sm"
              variant="danger"
              disabled={pending}
              onClick={purgeAll}
              className="shrink-0"
            >
              <Trash2 size={14} /> Empty trash
            </Button>
          )}
        </div>
        {trashed.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line py-20 text-center">
            <p className="text-sm text-muted">Trash is empty.</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line">
            {trashed.map((it) => (
              <TrashRow
                key={it.id}
                item={it}
                busy={pending}
                rowRef={(el) => {
                  const rows = rowRefs.current;
                  rows.set(it.id, el);
                  return () => {
                    rows.delete(it.id);
                  };
                }}
                onRestore={() => restore(it)}
                onPurge={() => purge(it)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TrashRow({
  item,
  busy,
  rowRef,
  onRestore,
  onPurge,
}: {
  item: TrashedTitle;
  busy: boolean;
  rowRef: React.Ref<HTMLDivElement>;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div ref={rowRef} className="flex items-center gap-3 bg-surface px-3 py-2.5">
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
        <div className="truncate text-sm font-medium">{item.name}</div>
        <div className="truncate text-xs text-muted">
          {item.mediaType === "TV" ? "TV" : "Movie"} · Deleted {fullDate(item.deletedAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            onRestore();
          }}
          className={softDisabledClass}
        >
          <RotateCcw size={14} /> Restore
        </Button>
        <Button
          size="sm"
          variant="danger"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            onPurge();
          }}
          className={softDisabledClass}
        >
          <Trash2 size={14} />
          <span className="hidden sm:inline">Delete forever</span>
          <span className="sm:hidden">Delete</span>
        </Button>
      </div>
    </div>
  );
}
