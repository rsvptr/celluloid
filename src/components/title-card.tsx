import { memo } from "react";
import Link from "next/link";
import { Check, Heart, Star } from "lucide-react";
import type { MediaType, WatchStatus } from "@/generated/prisma/client";
import { Poster } from "./poster";
import { Badge } from "./ui";
import { STATUS_META, progressPct } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Minimal shape the card renders — satisfied by both LibraryItem and ShareItem. */
export interface CardItem {
  id: string;
  name: string;
  mediaType: MediaType;
  tmdbId?: number | null;
  posterPath: string | null;
  year: number | null;
  language?: string | null;
  tmdbRating: number | null;
  status: WatchStatus;
  rating: number | null;
  favorite: boolean;
  totalEpisodes: number | null;
  watchedEpisodes: number;
  /** TV only: unwatched episodes that already aired and were discovered recently (D-F5).
   *  Optional — public share items (ShareItem) don't carry this field. */
  hasNewEpisodes?: boolean;
}

function TitleCardImpl({
  item,
  href,
  selectable = false,
  selected = false,
  onToggle,
  priority = false,
}: {
  item: CardItem;
  /** Link target; defaults to the detail page. `null` = non-interactive (read-only). */
  href?: string | null;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
  /** LCP hint — pass for the first few above-the-fold cards only. */
  priority?: boolean;
}) {
  const status = STATUS_META[item.status];
  const isTv = item.mediaType === "TV";
  const pct = isTv ? progressPct(item.watchedEpisodes, item.totalEpisodes) : 0;
  const target = href === undefined ? `/title/${item.id}` : href;

  const visual = (
    <>
      <div className="relative">
        <Poster
          path={item.posterPath}
          name={item.name}
          decorative
          mediaType={item.mediaType}
          priority={priority}
          className={cn(
            "ring-1 ring-line transition duration-200",
            selectable
              ? selected
                ? "ring-2 ring-brand"
                : "opacity-90 group-hover:opacity-100"
              : "group-hover:ring-2 group-hover:ring-brand/50",
          )}
        />

        {selectable ? (
          <span
            className={cn(
              "absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full ring-1 transition",
              selected
                ? "bg-brand text-[#04121c] ring-brand"
                : "bg-black/70 text-transparent ring-white/40 group-hover:text-white/70",
            )}
          >
            <Check size={14} strokeWidth={3} />
          </span>
        ) : (
          <span className="absolute left-1.5 top-1.5">
            <Badge className={status.badge}>
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {status.label}
            </Badge>
          </span>
        )}

        {!selectable && item.favorite && (
          <Heart
            size={16}
            className="absolute right-1.5 top-1.5 fill-rose-400 text-rose-400 drop-shadow"
          />
        )}
        {!selectable &&
        item.hasNewEpisodes &&
        item.status === "WATCHING" ? (
          <span
            className={cn(
              "absolute right-1.5 rounded-md bg-brand/90 px-1.5 py-0.5 text-[10px] font-medium text-[#04121c] shadow",
              // Stack under the favorite heart instead of overlapping it.
              item.favorite ? "top-7" : "top-1.5",
            )}
          >
            New
          </span>
        ) : null}
        {!selectable && item.tmdbRating ? (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] font-medium text-amber-300">
            <Star size={11} className="fill-amber-300" />
            {item.tmdbRating.toFixed(1)}
          </span>
        ) : null}
        {/* Strict null only: library DTOs carry an explicit null when truly
            unmatched; public share items omit the field (undefined), and the
            badge must not show there. */}
        {!selectable && item.tmdbId === null ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/90 ring-1 ring-amber-400/30">
            Unmatched
          </span>
        ) : null}
        {isTv && item.totalEpisodes ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            {/* transform instead of width: compositor-only animation, no layout thrash */}
            <div
              className="brand-gradient h-full origin-left transition-transform duration-500"
              style={{ transform: `scaleX(${pct / 100})` }}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-2">
        <h3 className="truncate text-sm font-medium text-foreground" title={item.name}>
          {item.name}
        </h3>
        <p className="truncate text-xs text-muted">
          {item.year || "Unknown"}
          {isTv && item.totalEpisodes
            ? ` · ${item.watchedEpisodes}/${item.totalEpisodes} eps`
            : ""}
          {item.rating ? ` · ★ ${item.rating}` : ""}
        </p>
      </div>
    </>
  );

  // No `content-visibility` here: its paint containment clips the poster's
  // hover ring (full-width child, ink extends past the card box) — observed
  // before Wave 1 and re-confirmed in review. List rows keep `cv-auto`; grid
  // cards rely on memoization + lazy images instead.
  const liftClass = "block transition duration-200 hover:-translate-y-1";

  // Selection mode: toggle instead of navigating.
  if (selectable) {
    return (
      <button
        type="button"
        onClick={() => onToggle?.(item.id)}
        aria-pressed={selected}
        className={cn("group w-full cursor-pointer text-left", liftClass)}
      >
        {visual}
      </button>
    );
  }

  // Read-only (no link) — used on public share pages.
  if (target === null) {
    return <div className="group block">{visual}</div>;
  }

  return (
    <Link href={target} className={cn("group", liftClass)}>
      {visual}
    </Link>
  );
}

/** Memoized so search/filter re-renders don't reconcile every card in a 200+ grid. */
export const TitleCard = memo(TitleCardImpl);
