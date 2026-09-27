"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui";
import { nameWithTypeAndYear } from "@/lib/format";
import { addFromTmdb } from "@/lib/actions";
import { saveWatchRegionPreference, setWatchRegion } from "@/lib/region-actions";
import { regionName, WATCH_REGIONS } from "@/lib/tmdb-extras";

/** One-click add for a "More like this" pick; links to the title once owned. */
export function QuickAdd({
  tmdbId,
  mediaType,
  name,
  year,
  existingId,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  name: string;
  year?: number | null;
  existingId?: string;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "adding" } | { kind: "done"; id: string }
  >(existingId ? { kind: "done", id: existingId } : { kind: "idle" });
  const [, start] = useTransition();
  const resultRef = useRef<HTMLAnchorElement>(null);
  const focusResult = useRef(false);

  useEffect(() => {
    if (state.kind === "done" && focusResult.current) {
      focusResult.current = false;
      resultRef.current?.focus();
    }
  }, [state.kind]);

  if (state.kind === "done") {
    return (
      <Link
        ref={resultRef}
        href={`/title/${state.id}`}
        className="focus-ring inline-flex w-fit items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[11px] font-medium text-emerald-300 ring-1 ring-emerald-500/30"
      >
        <Check size={11} /> In library
      </Link>
    );
  }

  return (
    <button
      type="button"
      disabled={state.kind === "adding"}
      aria-label={`Add ${nameWithTypeAndYear(name, mediaType, year)} to your watchlist`}
      onClick={() => {
        focusResult.current = true;
        start(async () => {
          setState({ kind: "adding" });
          const res = await addFromTmdb(tmdbId, mediaType);
          if (res.id) {
            setState({ kind: "done", id: res.id });
            if (res.restored)
              toast.success("Restored from Trash with your old ratings and notes.");
            else if (!res.existing) toast.success(`Added ${name} to your watchlist`);
          } else {
            setState({ kind: "idle" });
            toast.error(res.error ?? `Couldn't add ${name}. Please try again.`);
          }
        })
      }}
      className="focus-ring inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:opacity-60 sm:min-h-0"
    >
      {state.kind === "adding" ? <Spinner className="h-3 w-3" /> : <Plus size={11} />}
      Watchlist
    </button>
  );
}

/** Streaming-region picker; persists to a cookie and re-renders the page. */
export function RegionSelect({ region }: { region: string }) {
  const [pending, start] = useTransition();
  return (
    <select
      value={region}
      disabled={pending}
      aria-label="Streaming region"
      onChange={(e) => {
        const v = e.target.value;
        // The cookie write makes Next re-render the page into the action's
        // response, so there is nothing left to refresh.
        start(async () => {
          await setWatchRegion(v);
        });
        // Fire-and-forget: syncs the profile default without making the
        // region switch wait on it. The cookie above is the fast path.
        saveWatchRegionPreference(v).catch(() => {});
      }}
      className="has-chevron h-7 min-h-11 cursor-pointer appearance-none rounded-md bg-surface-2 pl-2 pr-7 text-xs text-muted ring-1 ring-line focus:outline-hidden focus:ring-2 focus:ring-brand/60 forced-colors:border disabled:opacity-60 sm:min-h-0"
    >
      {WATCH_REGIONS.map((r) => (
        <option key={r} value={r}>
          {regionName(r)}
        </option>
      ))}
    </select>
  );
}
