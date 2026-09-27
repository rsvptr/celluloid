import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * TMDB's required attribution (tmdb-docs/docs/faq.md, "What are the attribution
 * requirements?"): an approved logo linked to TMDB, plus this exact notice. The
 * logo must stay less prominent than Celluloid's own mark and must never be
 * recolored or distorted, so it is sized by height alone (w-auto keeps the
 * file's own aspect ratio). Server-safe: used by the public share page and by
 * the client-side settings screen.
 */
export function TmdbAttribution({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-faint", className)}>
      <a
        href="https://www.themoviedb.org"
        target="_blank"
        rel="noreferrer"
        className="focus-ring inline-flex shrink-0 rounded"
      >
        <Image src="/tmdb-logo.svg" alt="TMDB" width={92} height={12} className="h-3 w-auto" />
      </a>
      <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
    </p>
  );
}
