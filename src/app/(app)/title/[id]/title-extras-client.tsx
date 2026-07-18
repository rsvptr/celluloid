"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui";
import { addFromTmdb } from "@/lib/actions";
import { saveWatchRegionPreference, setWatchRegion } from "@/lib/region-actions";
import { regionName, WATCH_REGIONS } from "@/lib/tmdb-extras";

/** One-click add for a "More like this" pick; links to the title once owned. */
export function QuickAdd({
  tmdbId,
  mediaType,
  name,
  existingId,
}: {
  tmdbId: number;
  mediaType: "movie" | "tv";
  name: string;
  existingId?: string;
}) {
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "adding" } | { kind: "done"; id: string }
  >(existingId ? { kind: "done", id: existingId } : { kind: "idle" });
  const [, start] = useTransition();

  if (state.kind === "done") {
    return (
      <Link
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
      aria-label={`Add ${name} to your watchlist`}
      onClick={() =>
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
      }
      className="focus-ring inline-flex min-h-11 w-fit items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:opacity-60 sm:min-h-0"
    >
      {state.kind === "adding" ? <Spinner className="h-3 w-3" /> : <Plus size={11} />}
      Watchlist
    </button>
  );
}

/** Streaming-region picker; persists to a cookie and re-renders the page. */
export function RegionSelect({ region }: { region: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <select
      value={region}
      disabled={pending}
      aria-label="Streaming region"
      onChange={(e) => {
        const v = e.target.value;
        start(async () => {
          await setWatchRegion(v);
          router.refresh();
        });
        // Fire-and-forget: syncs the profile default without making the
        // region switch wait on it. The cookie above is the fast path.
        saveWatchRegionPreference(v).catch(() => {});
      }}
      className="has-chevron h-7 min-h-11 cursor-pointer appearance-none rounded-md bg-surface-2 pl-2 pr-7 text-xs text-muted ring-1 ring-line focus:outline-none focus:ring-2 focus:ring-brand/60 disabled:opacity-60 sm:min-h-0"
    >
      {WATCH_REGIONS.map((r) => (
        <option key={r} value={r}>
          {regionName(r)}
        </option>
      ))}
    </select>
  );
}
