"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckSquare,
  Dices,
  Download,
  Heart,
  LayoutGrid,
  List,
  Minus,
  Search,
  Share2,
  SlidersHorizontal,
  Tag as TagIcon,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { LibraryItem } from "@/lib/data";
import type { WatchStatus } from "@/generated/prisma/client";
import { Badge, Button, Input, Select } from "./ui";
import { TitleCard } from "./title-card";
import { Poster } from "./poster";
import { ShareDialog } from "./share-dialog";
import { useConfirm } from "./confirm-dialog";
import { AnimatePresence, motion } from "./motion";
import { STATUS_META, STATUS_ORDER, languageName, progressPct } from "@/lib/format";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkRemoveTitles,
  bulkSetFavorite,
  bulkSetStatus,
} from "@/lib/actions";
import { cn } from "@/lib/utils";

type SortKey = "added" | "watched" | "name" | "release" | "myrating" | "tmdb";
type TypeFilter = "all" | "MOVIE" | "TV";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "watched", label: "Recently watched" },
  { key: "name", label: "Name (A-Z)" },
  { key: "release", label: "Release (newest)" },
  { key: "myrating", label: "Your rating" },
  { key: "tmdb", label: "TMDB rating" },
];

export function Library({
  items,
  languages,
  tags,
}: {
  items: LibraryItem[];
  languages: string[];
  tags: string[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [type, setType] = useState<TypeFilter>("all");
  const [status, setStatus] = useState<WatchStatus | "all">("all");
  const [language, setLanguage] = useState<string>("all");
  const [tag, setTag] = useState<string>("all");
  const [genre, setGenre] = useState<string>("all");
  const [rating, setRating] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("added");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [onlyUnmatched, setOnlyUnmatched] = useState(false);
  const [showFilters, setShowFilters] = useState(false); // mobile filter drawer

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareOpen, setShareOpen] = useState(false);
  const [shareIds, setShareIds] = useState<string[]>([]);
  // Remember what was focused when the share dialog opened, to restore on close.
  const shareOpener = useRef<HTMLElement | null>(null);

  // Persist the filter/sort/view within the browsing session so returning from a
  // title detail (e.g. while working through the "Unrated" backlog) keeps the same
  // view instead of resetting to all titles. Session-scoped: a fresh tab starts clean.
  const skipFirstWrite = useRef(true);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("celluloid:libview");
      if (!raw) return;
      const s = JSON.parse(raw);
      // Validate every restored value against what's actually selectable now.
      // A stale value (say, a tag deleted since) would otherwise filter the list
      // invisibly while the select renders its first option.
      const oneOf = <T,>(v: unknown, allowed: readonly T[]): v is T =>
        allowed.includes(v as T);
      if (typeof s.query === "string") setQuery(s.query.slice(0, 200));
      if (oneOf(s.type, ["all", "MOVIE", "TV"] as const)) setType(s.type);
      if (
        oneOf(s.status, [
          "all",
          "WATCHLIST",
          "WATCHING",
          "WATCHED",
          "ON_HOLD",
          "DROPPED",
        ] as const)
      )
        setStatus(s.status);
      if (s.language === "all" || languages.includes(s.language)) setLanguage(s.language);
      if (s.tag === "all" || tags.includes(s.tag)) setTag(s.tag);
      if (s.genre === "all" || items.some((it) => it.genres.includes(s.genre)))
        setGenre(s.genre);
      if (oneOf(s.rating, ["all", "unrated", "9", "8", "7", "6", "5"] as const))
        setRating(s.rating);
      if (SORTS.some((x) => x.key === s.sort)) setSort(s.sort);
      if (s.view === "grid" || s.view === "list") setView(s.view);
      if (typeof s.onlyUnmatched === "boolean") setOnlyUnmatched(s.onlyUnmatched);
    } catch {
      // ignore malformed/unavailable storage
    }
    // Mount-only by design; props are stable for the life of this page view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Skip the mount write so it can't clobber saved state before the hydrate
    // effect's restored values have propagated.
    if (skipFirstWrite.current) {
      skipFirstWrite.current = false;
      return;
    }
    try {
      sessionStorage.setItem(
        "celluloid:libview",
        JSON.stringify({ query, type, status, language, tag, genre, rating, sort, view, onlyUnmatched }),
      );
    } catch {
      // storage may be unavailable (private mode); persistence is best-effort
    }
  }, [query, type, status, language, tag, genre, rating, sort, view, onlyUnmatched]);

  const genres = useMemo(
    () => [...new Set(items.flatMap((it) => it.genres))].sort(),
    [items],
  );

  const hasFilters =
    query !== "" ||
    type !== "all" ||
    status !== "all" ||
    language !== "all" ||
    tag !== "all" ||
    genre !== "all" ||
    rating !== "all" ||
    onlyUnmatched;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = items.filter((it) => {
      if (type !== "all" && it.mediaType !== type) return false;
      if (status !== "all" && it.status !== status) return false;
      if (language !== "all" && it.language !== language) return false;
      if (tag !== "all" && !it.tags.includes(tag)) return false;
      if (genre !== "all" && !it.genres.includes(genre)) return false;
      if (rating === "unrated" && it.rating != null) return false;
      if (rating !== "all" && rating !== "unrated") {
        if (it.rating == null || it.rating < Number(rating)) return false;
      }
      if (onlyUnmatched && it.tmdbId != null) return false;
      if (q && !it.name.toLowerCase().includes(q)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
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
    return list;
  }, [items, query, type, status, language, tag, genre, rating, sort, onlyUnmatched]);

  // Keep selection in sync with what's visible: drop any selected id that's no
  // longer in the filtered set (after a filter change or a refresh that removed
  // titles), so bulk actions can never touch hidden titles.
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(filtered.map((f) => f.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visible.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [filtered]);

  // The authoritative selection for actions: visible AND selected, in view order.
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

  function clearFilters() {
    setQuery("");
    setType("all");
    setStatus("all");
    setLanguage("all");
    setTag("all");
    setGenre("all");
    setRating("all");
    setOnlyUnmatched(false);
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

  return (
    <div className="flex flex-col gap-5 pb-24">
      {/* Toolbar */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Library</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              aria-label="Select titles"
              title="Select titles"
              className={cn(
                "focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 transition-colors",
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
                  className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground"
                >
                  <Dices size={15} />
                  <span className="hidden sm:inline">Surprise</span>
                </button>
                <button
                  onClick={() => openShare([])}
                  title="Share your library"
                  aria-label="Share your library"
                  className="focus-ring flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground"
                >
                  <Share2 size={15} />
                  <span className="hidden sm:inline">Share</span>
                </button>
              </>
            )}
            <div className="flex items-center gap-1 rounded-lg bg-surface-2 p-0.5 ring-1 ring-line">
              <ViewToggle active={view === "grid"} onClick={() => setView("grid")}>
                <LayoutGrid size={16} />
              </ViewToggle>
              <ViewToggle active={view === "list"} onClick={() => setView("list")}>
                <List size={16} />
              </ViewToggle>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <Search
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your library…"
              className="pl-9"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            aria-expanded={showFilters}
            className="focus-ring relative flex min-h-10 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:hidden"
          >
            <SlidersHorizontal size={15} /> Filters
            {hasFilters && (
              <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-brand" />
            )}
          </button>
          <div
            className={cn(
              showFilters
                ? "grid w-full grid-cols-2 gap-2 [&>*]:w-full sm:contents sm:[&>*]:w-auto"
                : "hidden sm:contents",
            )}
          >
          <Select value={type} onChange={(e) => setType(e.target.value as TypeFilter)}>
            <option value="all">All types</option>
            <option value="MOVIE">Movies</option>
            <option value="TV">TV shows</option>
          </Select>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as WatchStatus | "all")}
          >
            <option value="all">Any status</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </Select>
          {languages.length > 1 && (
            <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="all">Any language</option>
              {languages.map((l) => (
                <option key={l} value={l}>
                  {languageName(l)}
                </option>
              ))}
            </Select>
          )}
          {genres.length > 1 && (
            <Select value={genre} onChange={(e) => setGenre(e.target.value)}>
              <option value="all">Any genre</option>
              {genres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </Select>
          )}
          <Select value={rating} onChange={(e) => setRating(e.target.value)}>
            <option value="all">Any rating</option>
            <option value="unrated">Unrated</option>
            <option value="9">9+</option>
            <option value="8">8+</option>
            <option value="7">7+</option>
            <option value="6">6+</option>
            <option value="5">5+</option>
          </Select>
          {tags.length > 0 && (
            <Select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="all">Any tag</option>
              {tags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          )}
          <Select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
          <button
            onClick={() => setOnlyUnmatched((v) => !v)}
            title="Show titles with no TMDB match"
            className={cn(
              "focus-ring rounded-lg px-2.5 py-1.5 text-sm ring-1 transition-colors",
              onlyUnmatched
                ? "bg-amber-500/15 text-amber-300 ring-amber-500/30"
                : "text-muted ring-line hover:text-foreground",
            )}
          >
            Needs match
          </button>
          {hasFilters && (
            <button
              onClick={clearFilters}
              className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted hover:text-foreground"
            >
              <X size={14} /> Clear
            </button>
          )}
          {hasFilters && (
            <Link
              href={exportHref}
              title="Open Export with these filters applied"
              className="focus-ring flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-muted hover:text-foreground"
            >
              <Download size={14} /> Export these
            </Link>
          )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted">
            {filtered.length} {filtered.length === 1 ? "title" : "titles"}
            {hasFilters ? ` of ${items.length}` : ""}
          </p>
          {selectMode && filtered.length > 0 && (
            <button
              onClick={() =>
                setSelected(
                  selectedIds.length === filtered.length
                    ? new Set()
                    : new Set(filtered.map((f) => f.id)),
                )
              }
              className="focus-ring rounded text-xs font-medium text-brand hover:underline"
            >
              {selectedIds.length === filtered.length ? "Deselect all" : "Select all"}
            </button>
          )}
        </div>
      </div>

      {/* Results */}
      {filtered.length === 0 ? (
        <EmptyState hasItems={items.length > 0} />
      ) : view === "grid" ? (
        <div className="grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
          {filtered.map((it) => (
            <TitleCard
              key={it.id}
              item={it}
              selectable={selectMode}
              selected={selected.has(it.id)}
              onToggle={toggle}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line">
          {filtered.map((it) => (
            <ListRow
              key={it.id}
              item={it}
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
  const { confirm, dialog } = useConfirm();
  const disabled = pending || count === 0;

  function run(fn: () => Promise<{ count: number } | { count: number; tag: string }>, verb: string) {
    start(async () => {
      try {
        const res = await fn();
        toast.success(`${verb} ${res.count} ${res.count === 1 ? "title" : "titles"}`);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        // Always re-sync to the server so a partial failure can't leave stale UI.
        router.refresh();
      }
    });
  }

  return (
    <>
      {dialog}
      <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-x-0 bottom-0 z-40 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-2 rounded-2xl bg-surface/95 p-2.5 shadow-xl ring-1 ring-line backdrop-blur-md sm:flex-nowrap sm:overflow-x-auto sm:[&>*]:shrink-0">
            <span className="px-2 text-sm font-medium tabular-nums">
              {count} selected
            </span>

            <Select
              value=""
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value as WatchStatus;
                if (v) run(() => bulkSetStatus(ids, v), "Updated");
              }}
              className="w-auto"
            >
              <option value="">Set status…</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </Select>

            <div className="flex items-center gap-1">
              <Input
                list="bulk-tags"
                value={newTag}
                onChange={(e) => setNewTag(e.target.value)}
                placeholder="Add tag…"
                disabled={disabled}
                className="h-9 w-32"
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
                disabled={disabled || !newTag.trim()}
                onClick={() => {
                  run(() => bulkAddTag(ids, newTag.trim()), "Tagged");
                  setNewTag("");
                }}
                title="Add this tag to selected"
              >
                <TagIcon size={14} />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || !newTag.trim()}
                onClick={() => {
                  run(() => bulkRemoveTag(ids, newTag.trim()), "Untagged");
                  setNewTag("");
                }}
                title="Remove this tag from selected"
              >
                <Minus size={14} />
              </Button>
            </div>

            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => run(() => bulkSetFavorite(ids, true), "Favorited")}
            >
              <Heart size={14} /> Favorite
            </Button>

            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => run(() => bulkSetFavorite(ids, false), "Unfavorited")}
            >
              <Heart size={14} className="text-faint" /> Unfavorite
            </Button>

            <Button size="sm" variant="secondary" disabled={disabled} onClick={onShare}>
              <Share2 size={14} /> Share
            </Button>

            <Button
              size="sm"
              variant="danger"
              disabled={disabled}
              onClick={async () => {
                if (
                  !(await confirm({
                    title: `Remove ${count} ${count === 1 ? "title" : "titles"}?`,
                    body: "This can't be undone.",
                    confirmLabel: "Remove",
                    destructive: true,
                  }))
                )
                  return;
                run(() => bulkRemoveTitles(ids).then((r) => (onDone(), r)), "Removed");
              }}
            >
              <Trash2 size={14} /> Remove
            </Button>

            <button
              onClick={onDone}
              className="focus-ring ml-auto rounded-lg px-2.5 py-1.5 text-sm text-muted hover:text-foreground"
            >
              Done
            </button>
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
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "focus-ring flex h-9 w-9 items-center justify-center rounded-md transition-colors sm:h-7 sm:w-7",
        active ? "bg-surface text-foreground" : "text-muted hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ListRow({
  item,
  selectMode,
  selected,
  onToggle,
}: {
  item: LibraryItem;
  selectMode: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const status = STATUS_META[item.status];
  const isTv = item.mediaType === "TV";
  const pct = isTv ? progressPct(item.watchedEpisodes, item.totalEpisodes) : 0;

  const inner = (
    <>
      <div className="w-9 shrink-0">
        <Poster
          path={item.posterPath}
          name={item.name}
          mediaType={item.mediaType}
          size="w92"
          sizes="36px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{item.name}</span>
          {item.favorite && <Heart size={12} className="fill-rose-400 text-rose-400" />}
        </div>
        <div className="truncate text-xs text-muted">
          {isTv ? "TV" : "Movie"} · {item.year || "Unknown"}
          {isTv && item.totalEpisodes ? ` · ${item.watchedEpisodes}/${item.totalEpisodes} eps (${pct}%)` : ""}
          {item.language ? ` · ${languageName(item.language)}` : ""}
          {item.rating ? ` · ★ ${item.rating}` : ""}
        </div>
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
        className={cn(
          "focus-ring flex items-center gap-3 px-3 py-2.5 text-left transition-colors",
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
      className="focus-ring flex items-center gap-3 bg-surface px-3 py-2.5 transition-colors hover:bg-surface-2/50"
    >
      {inner}
    </Link>
  );
}

function EmptyState({ hasItems }: { hasItems: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line py-20 text-center">
      <p className="text-sm text-muted">
        {hasItems ? "No titles match your filters." : "Your library is empty."}
      </p>
      <Link href="/add" className="focus-ring rounded text-sm font-medium text-brand hover:underline">
        {hasItems ? "Try clearing filters" : "Add your first title →"}
      </Link>
    </div>
  );
}
