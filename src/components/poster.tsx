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
  priority,
}: {
  path: string | null | undefined;
  name: string;
  mediaType: MediaType;
  size?: PosterSize;
  sizes?: string;
  className?: string;
  priority?: boolean;
}) {
  const url = posterUrl(path, size);
  return (
    <div
      className={cn(
        "relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-surface-2",
        className,
      )}
    >
      {url ? (
        <Image
          src={url}
          alt={name}
          fill
          sizes={sizes ?? "(max-width: 640px) 40vw, 180px"}
          className="object-cover"
          priority={priority}
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
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-surface-2 to-surface p-3 text-center">
      <Icon className="text-faint" size={28} />
      <span className="line-clamp-3 text-xs font-medium text-muted">{name}</span>
    </div>
  );
}
