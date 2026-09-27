"use client";

import { useState } from "react";
import Image from "next/image";
import { Film, Tv } from "lucide-react";
import type { MediaType } from "@/generated/prisma/client";
import { posterUrl, type PosterSize } from "@/lib/images";
import { cn } from "@/lib/utils";

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
  // If a custom loader lands (VE-07), check onError still fires for TMDB 404s.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <div
      className={cn(
        "relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-2",
        className,
      )}
      aria-hidden={decorative || undefined}
    >
      {url && failedUrl !== url ? (
        <Image
          src={url}
          alt={decorative ? "" : name}
          fill
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
