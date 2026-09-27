"use client";

import Image, { type ImageProps } from "next/image";
import { TMDB_IMAGE_BASE, tmdbSize, type TmdbImageKind, type TmdbSize } from "@/lib/images";

/**
 * next/image for a TMDB file. The browser fetches the size it needs straight
 * from image.tmdb.org, which already serves every size as WebP with a
 * one-year cache, instead of /_next/image resizing it a second time (VE-07).
 * A loader on each TMDB image rather than images.loaderFile, which would apply
 * to every next/image and stop optimizing local files such as logo.png.
 *
 * `maxSize` is the size the slot fetched before this loader, so no slot
 * downloads a heavier file than it used to. A client component because the
 * loader is a function, which a server component can't pass as a prop.
 */
export function TmdbImage<K extends TmdbImageKind>({
  path,
  kind,
  maxSize,
  alt,
  ...props
}: Omit<ImageProps, "src" | "loader"> & {
  /** TMDB file path, e.g. "/abc.jpg". */
  path: string;
  kind: K;
  maxSize: TmdbSize<K>;
}) {
  return (
    <Image
      {...props}
      alt={alt}
      // Next uses `src` only to identify the image; the loader builds every
      // URL. The size-free original keeps `src` distinct from those URLs, which
      // Next's dev check would otherwise read as a loader that ignores width.
      src={`${TMDB_IMAGE_BASE}original${path}`}
      loader={({ width }) => `${TMDB_IMAGE_BASE}${tmdbSize(kind, width, maxSize)}${path}`}
    />
  );
}
