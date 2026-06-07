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
}

function TitleCardImpl({
  item,
  href,
  selectable = false,
  selected = false,
  onToggle,
}: {
  item: CardItem;
  /** Link target; defaults to the detail page. `null` = non-interactive (read-only). */
  href?: string | null;
  selectable?: boolean;
  selected?: boolean;
  onToggle?: (id: string) => void;
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
          mediaType={item.mediaType}
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
                : "bg-black/55 text-transparent ring-white/40 backdrop-blur-sm group-hover:text-white/70",
            )}
          >
            <Check size={14} strokeWidth={3} />
          </span>
        ) : (
          <span className="absolute left-1.5 top-1.5">
            <Badge className={cn(status.badge, "backdrop-blur-sm")}>
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
        {!selectable && item.tmdbRating ? (
          <span className="absolute bottom-1.5 right-1.5 flex items-center gap-0.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 backdrop-blur-sm">
            <Star size={11} className="fill-amber-300" />
            {item.tmdbRating.toFixed(1)}
          </span>
        ) : null}
        {!selectable && item.tmdbId == null ? (
          <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-amber-300/90 backdrop-blur-sm ring-1 ring-amber-400/30">
            No TMDB
          </span>
        ) : null}
        {isTv && item.totalEpisodes ? (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="brand-gradient h-full transition-[width] duration-500" style={{ width: `${pct}%` }} />
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

  const liftClass =
    "block transition duration-200 will-change-transform hover:-translate-y-1";

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
