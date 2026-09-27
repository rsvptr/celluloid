"use client";

import Link from "next/link";
import { Download, Trash2 } from "lucide-react";
import type { WatchStatus } from "@/generated/prisma/client";
import type { RatingFilter, SortKey } from "@/lib/library-filters";
import { hasLibraryFilters, libraryExportHref } from "@/lib/library-filter-state";
import { Card, Select } from "./ui";
import { useLibraryFilters } from "./library-filters-context";
import { AnimatePresence, EASE_OUT, InertOnExit, motion } from "./motion";
import { STATUS_META, STATUS_ORDER, languageName } from "@/lib/format";
import { cn } from "@/lib/utils";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "added", label: "Recently added" },
  { key: "watched", label: "Recently watched" },
  { key: "name", label: "Name (A–Z)" },
  { key: "release", label: "Release (newest)" },
  { key: "myrating", label: "Your rating" },
  { key: "tmdb", label: "TMDB rating" },
];

// Advanced filters — collapsed by default; the only entry point is the Row 2
// disclosure button. Inline region, so focus is never trapped.
export function LibraryFilterPanel({
  showFilters,
  trashedCount,
  onOpenTrash,
}: {
  showFilters: boolean;
  trashedCount: number;
  onOpenTrash: () => void;
}) {
  const {
    state,
    actions: { set },
    meta: { languages, genres, tags },
  } = useLibraryFilters();
  const { status, language, genre, rating, tag, sort, onlyUnmatched, onlyOnServices } = state;
  const hasFilters = hasLibraryFilters(state);
  const exportHref = libraryExportHref(state);

  return (
    <AnimatePresence>
      {showFilters && (
        <motion.div
          key="advanced-filters"
          id="library-advanced-filters"
          // The reveal is CSS (collapse-in), so the open panel is visible
          // even if Motion's features never load; Motion only runs the exit
          // (and a reopen mid-exit). Without features it unmounts at once,
          // so a closed panel is never focusable; with them, InertOnExit takes
          // it out of the tab order as the exit starts. -mt-4 here and mt-4 on
          // the Card cancel the parent's gap-4, so the collapsed panel
          // takes no space and the gap never jumps.
          initial={false}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="-mt-4 grid grid-rows-[1fr] overflow-hidden motion-safe:animate-[collapse-in_200ms_var(--ease-out)]"
        >
          <InertOnExit className="min-h-0">
          <Card variant="inset" className="mt-4 flex flex-col gap-3 p-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Select
                value={status}
                onChange={(e) => set({ status: e.target.value as WatchStatus | "all" })}
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
                  onChange={(e) => set({ language: e.target.value })}
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
                  onChange={(e) => set({ genre: e.target.value })}
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
                onChange={(e) => set({ rating: e.target.value as RatingFilter })}
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
                  onChange={(e) => set({ tag: e.target.value })}
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
                onChange={(e) => set({ sort: e.target.value as SortKey })}
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
                onClick={() => set((f) => ({ onlyUnmatched: !f.onlyUnmatched }))}
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
                    onClick={onOpenTrash}
                    className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2 text-sm text-muted transition-colors hover:text-foreground sm:min-h-0"
                  >
                    <Trash2 size={16} /> Trash ({trashedCount})
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
                    <Download size={16} /> Export these
                  </Link>
                )}
              </div>
            )}
          </Card>
          </InertOnExit>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
