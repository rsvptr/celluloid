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
    <div
      className={cn(
        "cv-auto-card",
        // The ring below is flush with the poster's top/left/right edges, so
        // content-visibility's paint containment (contain: paint) would clip it
        // exactly the way an overflow-hidden ancestor would — reserve 2px on
        // those three edges (the widest the ring gets, at ring-2) and cancel it
        // with an equal negative margin so neither the poster nor the card's
        // grid footprint actually changes size. The bottom edge doesn't need
        // it: the ring there lands well inside the text block below, never
        // near this box's edge. Needs the outer element's `flow-root` (see
        // liftClass) — otherwise -mt-0.5 collapses into its margin instead of
        // staying put.
        "-mx-0.5 -mt-0.5 px-0.5 pt-0.5",
      )}
    >
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
            {/* Opaque chip, like the rating chip below: the status tint alone is
                15% and left the text unreadable on bright posters (JK-01). Every
                status text color stays above 5.4:1 on bg-black/75 even over a
                white poster, and keeping it preserves the hue cue. */}
            <Badge className={cn(status.badge, "bg-black/75")}>
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {status.label}
            </Badge>
          </span>
        )}

        {!selectable && item.favorite && (
          <span className="absolute right-1.5 top-1.5">
            <Heart size={16} aria-hidden="true" className="fill-rose-400 text-rose-400 drop-shadow" />
            <span className="sr-only">Favorite</span>
          </span>
        )}
        {/* Every status except DROPPED. The gate used to also require
            WATCHING, which silently withheld the badge from the cases it is
            most useful for: a show parked in WATCHLIST or ON_HOLD that has
            started airing again, and a series finished long ago that just
            came back for another season. DROPPED is the one status where a
            new episode is genuinely not wanted. */}
        {!selectable && item.hasNewEpisodes && item.status !== "DROPPED" ? (
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
        {/* h2, not h3: the library grid's only other heading is its <h1>, so an
            h3 here left a 200-card hole at level 2 in the outline. The share
            page nests these under its own "Titles" h2, where a same-level
            heading still reads as contiguous. */}
        <h2 className="truncate text-sm font-medium text-foreground" title={item.name}>
          {item.name}
        </h2>
        <p className="truncate text-xs text-muted">
          {item.year || "Unknown"}
          {isTv && item.totalEpisodes
            ? ` · ${item.watchedEpisodes}/${item.totalEpisodes} eps`
            : ""}
          {item.rating ? ` · ★ ${item.rating}` : ""}
        </p>
      </div>
    </div>
  );

  // flow-root, not block: establishes a block formatting context so the
  // visual wrapper's -mt-0.5 (above) can't collapse into this element's own
  // margin and drag the whole card upward inside the grid — flow-root has the
  // same block-level sizing as `block`, it just also stops that collapse.
  const liftClass = "flow-root transition duration-200 hover:-translate-y-1";

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

  // Read-only (no link) — used on public share pages. Still flow-root (see
  // liftClass above) for the same reason: the visual wrapper's -mt-0.5 needs a
  // formatting-context boundary regardless of whether this card is interactive.
  if (target === null) {
    return <div className="group flow-root">{visual}</div>;
  }

  return (
    <Link href={target} className={cn("group", liftClass)}>
      {visual}
    </Link>
  );
}

/** Memoized so search/filter re-renders don't reconcile every card in a 200+ grid. */
export const TitleCard = memo(TitleCardImpl);
