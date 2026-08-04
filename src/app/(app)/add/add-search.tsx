"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import type { SearchResult } from "@/app/api/search/route";
import { Spinner } from "@/components/ui";
import { TmdbSearch } from "@/components/tmdb-search";
import { addFromTmdb } from "@/lib/actions";

type AddState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "added"; id: string }
  | { kind: "exists"; id: string }
  | { kind: "error"; message: string };

export function AddSearch({ initialQuery }: { initialQuery?: string }) {
  const [states, setStates] = useState<Record<string, AddState>>({});
  const [, startTransition] = useTransition();

  function add(r: SearchResult) {
    const key = `${r.mediaType}:${r.tmdbId}`;
    setStates((s) => ({ ...s, [key]: { kind: "adding" } }));
    startTransition(async () => {
      try {
        const res = await addFromTmdb(r.tmdbId, r.mediaType);
        if (res.restored)
          toast.success("Restored from Trash with your old ratings and notes.");
        setStates((s) => ({
          ...s,
          [key]: res.error
            ? { kind: "error", message: res.error }
            : res.existing
              ? { kind: "exists", id: res.id! }
              : { kind: "added", id: res.id! },
        }));
      } catch {
        setStates((s) => ({
          ...s,
          [key]: {
            kind: "error",
            message: "Celluloid couldn't add this title. Check your connection and retry.",
          },
        }));
      }
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Add to library</h1>
        <p className="mt-1 text-sm text-muted">
          Search The Movie Database for any film or show.
        </p>
      </div>

      <TmdbSearch
        autoFocus
        initialQuery={initialQuery}
        renderAction={(r) => {
          const key = `${r.mediaType}:${r.tmdbId}`;
          const state = states[key] ?? { kind: "idle" };
          return <AddButton name={r.name} state={state} onAdd={() => add(r)} />;
        }}
      />
    </div>
  );
}

function AddButton({
  name,
  state,
  onAdd,
}: {
  name: string;
  state: AddState;
  onAdd: () => void;
}) {
  const resultRef = useRef<HTMLAnchorElement>(null);
  const focusResult = useRef(false);

  useEffect(() => {
    if (
      (state.kind === "added" || state.kind === "exists") &&
      focusResult.current
    ) {
      focusResult.current = false;
      resultRef.current?.focus();
    }
  }, [state.kind]);

  function beginAdd() {
    focusResult.current = true;
    onAdd();
  }

  if (state.kind === "added" || state.kind === "exists") {
    return (
      <Link
        ref={resultRef}
        href={`/title/${state.id}`}
        aria-label={`View ${name} in your library`}
        className="focus-ring flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25 sm:min-h-0"
      >
        <Check size={15} aria-hidden="true" />
        {state.kind === "added" ? "Added" : "In library"}
      </Link>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex shrink-0 flex-col items-end gap-1">
        <button
          type="button"
          onClick={beginAdd}
          aria-label={`Retry adding ${name}`}
          title={state.message}
          className="focus-ring min-h-11 shrink-0 rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30 sm:min-h-0"
        >
          Retry
        </button>
        <p role="alert" className="max-w-[10rem] text-right text-[11px] text-rose-300">
          {state.message}
        </p>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={beginAdd}
      disabled={state.kind === "adding"}
      aria-label={`Add ${name} to your library`}
      className="focus-ring brand-gradient flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-[#04121c] hover:opacity-90 disabled:opacity-60 sm:min-h-0"
    >
      {state.kind === "adding" ? <Spinner /> : <Plus size={15} aria-hidden="true" />}
      Add
    </button>
  );
}
