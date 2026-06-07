"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Plus } from "lucide-react";
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
      const res = await addFromTmdb(r.tmdbId, r.mediaType);
      setStates((s) => ({
        ...s,
        [key]: res.error
          ? { kind: "error", message: res.error }
          : res.existing
            ? { kind: "exists", id: res.id! }
            : { kind: "added", id: res.id! },
      }));
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
          return <AddButton state={state} onAdd={() => add(r)} />;
        }}
      />
    </div>
  );
}

function AddButton({ state, onAdd }: { state: AddState; onAdd: () => void }) {
  if (state.kind === "added" || state.kind === "exists") {
    return (
      <Link
        href={`/title/${state.id}`}
        className="focus-ring flex shrink-0 items-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-300 ring-1 ring-emerald-500/30 hover:bg-emerald-500/25"
      >
        <Check size={15} />
        {state.kind === "added" ? "Added" : "In library"}
      </Link>
    );
  }
  if (state.kind === "error") {
    return (
      <button
        onClick={onAdd}
        title={state.message}
        className="focus-ring shrink-0 rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/30"
      >
        Retry
      </button>
    );
  }
  return (
    <button
      onClick={onAdd}
      disabled={state.kind === "adding"}
      className="focus-ring brand-gradient flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold text-[#04121c] hover:opacity-90 disabled:opacity-60"
    >
      {state.kind === "adding" ? <Spinner /> : <Plus size={15} />}
      Add
    </button>
  );
}
