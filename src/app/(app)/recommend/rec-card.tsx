"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Ban, Check, Eye, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import type { Recommendation } from "@/lib/recommend";
import { Card, Spinner } from "@/components/ui";
import { Poster } from "@/components/poster";
import { addFromTmdb } from "@/lib/actions";
import { languageName, nameWithTypeAndYear } from "@/lib/format";
import { cn } from "@/lib/utils";

// Neutral and graded by emphasis, not hue: emerald, amber and slate are the
// Watched, Watching and On hold statuses, and a "Medium" pick must not read as
// Watching (JK-17). The label carries the level.
const CONFIDENCE = {
  high: "bg-surface-2 text-foreground ring-line-strong",
  medium: "bg-surface-2 text-muted ring-line-strong",
  low: "bg-surface-2 text-faint ring-line",
} as const;

const CONFIDENCE_LABELS: Record<Recommendation["confidence"], string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Why a suggestion was hidden — mirrors SuppressionReason in the Prisma schema. */
export type DismissReason = "NOT_INTERESTED" | "SEEN_ELSEWHERE";

type AddState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "done"; id: string; existing?: boolean };

export function RecCard({
  rec,
  onDismiss,
}: {
  rec: Recommendation;
  onDismiss: (reason: DismissReason) => void;
}) {
  const [state, setState] = useState<AddState>({ kind: "idle" });
  const [, start] = useTransition();
  const resultRef = useRef<HTMLAnchorElement>(null);
  const focusResult = useRef(false);

  useEffect(() => {
    if (state.kind === "done" && focusResult.current) {
      focusResult.current = false;
      resultRef.current?.focus();
    }
  }, [state.kind]);

  return (
    <Card className="flex items-start gap-3 p-3">
      <div className="w-14 shrink-0">
        <Poster
          path={rec.posterPath}
          name={rec.title}
          decorative
          mediaType={rec.mediaType === "tv" ? "TV" : "MOVIE"}
          size="w185"
          sizes="56px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium">{rec.title}</span>
          <span className="text-xs text-muted">
            {rec.mediaType === "tv" ? "TV" : "Movie"}
            {rec.year ? ` · ${rec.year}` : ""}
            {rec.language ? ` · ${languageName(rec.language)}` : ""}
          </span>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
              CONFIDENCE[rec.confidence],
            )}
          >
            {CONFIDENCE_LABELS[rec.confidence]}
          </span>
        </div>
        <p className="mt-1 text-sm text-foreground/85">{rec.reason}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        {rec.tmdbId ? (
          state.kind === "done" ? (
            <Link
              ref={resultRef}
              href={`/title/${state.id}`}
              aria-label={`View ${nameWithTypeAndYear(rec.title, rec.mediaType, rec.year)} in your watchlist`}
              className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 sm:min-h-0"
            >
              <Check size={16} aria-hidden="true" /> {state.existing ? "In library" : "Added"}
            </Link>
          ) : (
            <button
              type="button"
              disabled={state.kind === "adding"}
              aria-label={`Add ${nameWithTypeAndYear(rec.title, rec.mediaType, rec.year)} to your watchlist`}
              onClick={() => {
                focusResult.current = true;
                start(async () => {
                  setState({ kind: "adding" });
                  try {
                    const res = await addFromTmdb(rec.tmdbId!, rec.mediaType);
                    if (res.id) {
                      setState({ kind: "done", id: res.id, existing: res.existing });
                      if (res.restored) {
                        toast.success(
                          "Restored from Trash with your old ratings and notes.",
                        );
                      }
                      return;
                    }
                    setState({ kind: "idle" });
                    toast.error(
                      res.error ?? "Couldn't add that title. Please try again.",
                    );
                  } catch {
                    setState({ kind: "idle" });
                    toast.error(
                      "Celluloid couldn't add that title. Check your connection and retry.",
                    );
                  }
                })
              }}
              className="focus-ring brand-gradient flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-on-accent hover:opacity-90 disabled:opacity-60 sm:min-h-0"
            >
              {state.kind === "adding" ? <Spinner /> : <Plus size={16} aria-hidden="true" />}
              Watchlist
            </button>
          )
        ) : (
          <Link
            href={`/add?q=${encodeURIComponent(rec.title)}`}
            aria-label={`Search TMDB for ${rec.title}`}
            title="Not matched automatically. Search TMDB to add it."
            className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-0"
          >
            <Search size={13} aria-hidden="true" /> Find on TMDB
          </Link>
        )}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onDismiss("SEEN_ELSEWHERE")}
            aria-label={`Seen ${rec.title} elsewhere`}
            title="Seen it: keep this out of future suggestions"
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-9 sm:min-w-9"
          >
            <Eye size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => onDismiss("NOT_INTERESTED")}
            aria-label={`Not interested in ${rec.title}`}
            title="Not interested: keep this out of future suggestions"
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-9 sm:min-w-9"
          >
            <Ban size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
    </Card>
  );
}
