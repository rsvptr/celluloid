"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { RefreshCw, Replace, X } from "lucide-react";
import { toast } from "sonner";
import type { SearchResult } from "@/app/api/search/route";
import { Button, Spinner } from "@/components/ui";
import { TmdbSearch } from "@/components/tmdb-search";
import { rematchTitle } from "@/lib/actions";

export function MatchControls({
  titleId,
  tmdbId,
  mediaType,
  name,
}: {
  titleId: string;
  tmdbId: number | null;
  mediaType: "MOVIE" | "TV";
  name: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const opener = useRef<HTMLElement | null>(null);

  function pick(r: SearchResult) {
    start(async () => {
      const res = await rematchTitle(titleId, r.tmdbId, r.mediaType);
      if (res.error) {
        toast.error(
          res.error,
          res.existingId
            ? {
                action: {
                  label: "Open",
                  onClick: () => router.push(`/title/${res.existingId}`),
                },
              }
            : undefined,
        );
        return;
      }
      toast.success("Match updated");
      setOpen(false);
      router.refresh();
    });
  }

  function refresh() {
    if (tmdbId == null) return;
    startRefresh(async () => {
      const res = await rematchTitle(
        titleId,
        tmdbId,
        mediaType === "TV" ? "tv" : "movie",
      );
      if (res.error) toast.error(res.error);
      else {
        toast.success("Metadata refreshed");
        router.refresh();
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={(e) => {
          opener.current = e.currentTarget;
          setOpen(true);
        }}
      >
        <Replace size={14} />
        {tmdbId == null ? "Match to TMDB" : "Change match"}
      </Button>
      {tmdbId != null && (
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={refresh}>
          {refreshing ? <Spinner /> : <RefreshCw size={14} />}
          Refresh metadata
        </Button>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-[dialog-overlay-in_0.2s_ease-out]" />
          <Dialog.Content
            onCloseAutoFocus={(e) => {
              if (opener.current) {
                e.preventDefault();
                opener.current.focus();
              }
            }}
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none data-[state=open]:animate-[dialog-content-in_0.2s_cubic-bezier(0.16,1,0.3,1)]"
          >
            <Dialog.Close
              className="absolute right-3 top-3 rounded text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
              aria-label="Close"
            >
              <X size={18} />
            </Dialog.Close>
            <Dialog.Title className="text-sm font-semibold">
              Change match for “{name}”
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-muted">
              Pick the correct title. Your status, rating, notes, tags, and watch
              progress all stay put.
            </Dialog.Description>
            <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
              <TmdbSearch
                autoFocus
                onPick={pick}
                placeholder="Search the correct title…"
              />
            </div>
            {pending && (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <Spinner /> Updating match…
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
