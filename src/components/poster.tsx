"use client";

import { useState } from "react";
import { Film, Tv } from "lucide-react";
import type { MediaType } from "@/generated/prisma/client";
import { posterUrl, type PosterSize } from "@/lib/images";
import { cn } from "@/lib/utils";
import { TmdbImage } from "./tmdb-image";

export function Poster({
  path,
  name,
  mediaType,
  size = "w342",
  sizes,
  className,
  lcp,
  decorative = false,
}: {
  path: string | null | undefined;
  name: string;
  mediaType: MediaType;
  size?: PosterSize;
  sizes?: string;
  className?: string;
  /** LCP hint: "preload" (high priority) for the one or two likeliest LCP
   *  images only, "eager" for the rest of the first visible row. */
  lcp?: "preload" | "eager";
  /** Hide the image from assistive tech when nearby text already names the title. */
  decorative?: boolean;
}) {
  const url = posterUrl(path, size);
  // Keyed by URL, so a new path (e.g. after a re-match) gets a fresh attempt.
  // The browser now fetches from TMDB itself (VE-07), and TMDB answers a
  // missing file with a 404 HTML page, which fails to decode: onError fires.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div
      className={cn(
        "relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-2",
        className,
      )}
      aria-hidden={decorative || undefined}
    >
      {path && failedUrl !== url ? (
        <TmdbImage
          path={path}
          kind="poster"
          maxSize={size}
          alt={decorative ? "" : name}
          fill
          // The grid default: 40vw keeps Next's candidates at 256 px and up, so
          // a card fetches w342 even at DPR 1. That's a larger file than the
          // old 256 px re-encode, the trade VE-07 accepted (P7U-2).
          sizes={sizes ?? "(max-width: 640px) 40vw, 180px"}
          className="object-cover"
          preload={lcp === "preload"}
          fetchPriority={lcp === "preload" ? "high" : undefined}
          loading={lcp === "eager" ? "eager" : undefined}
          onError={() => setFailedUrl(url)}
        />
      ) : (
        <PlaceholderPoster name={name} mediaType={mediaType} />
      )}
    </div>
  );
}

function PlaceholderPoster({
  name,
  mediaType,
}: {
  name: string;
  mediaType: MediaType;
}) {
  const Icon = mediaType === "TV" ? Tv : Film;
  // Thumbnails (36-56px) have no room for the name: icon only, sized down.
  // The outer div is the query container (an element can't query itself).
  return (
    <div className="@container h-full w-full bg-gradient-to-br from-surface-2 to-surface">
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-1 text-center @min-[80px]:p-3">
        <Icon aria-hidden="true" className="size-4 text-faint @min-[80px]:size-7" />
        <span className="hidden text-xs font-medium text-muted @min-[80px]:line-clamp-3">{name}</span>
      </div>
    </div>
  );
}
