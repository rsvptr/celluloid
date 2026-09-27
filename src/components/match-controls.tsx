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
  const contentRef = useRef<HTMLDivElement>(null);
  // A toast to raise once the dialog has fully closed (see pick).
  const afterClose = useRef<(() => void) | null>(null);
  // A title with no tmdbId has never been matched, so every string here has to
  // read as a first match rather than a correction.
  const unmatched = tmdbId == null;
  // What the dialog shows, held while it plays its exit (EM-03). A pick that
  // closes it, saved or already in the library, does so in the same commit
  // that ends `pending` (and a save brings the rematched title's props), which
  // would swap the heading and drop the saving row mid-fade. `saved` means
  // "closing after a pick". Taken afresh on every open.
  const [shown, setShown] = useState({ name, unmatched, saved: false });
  const busy = pending || shown.saved;

  function pick(r: SearchResult) {
    if (pending) return; // one rematch at a time; a second pick would race it
    start(async () => {
      const res = await rematchTitle(titleId, r.tmdbId, r.mediaType);
      if (res.error) {
        const { error, existingId } = res;
        if (!existingId) {
          toast.error(error);
          return;
        }
        // The pick is already in the library, and the toast offers to open
        // it. While this modal dialog is open the rest of the page is inert
        // (Radix sets pointer-events: none on <body>, traps focus and
        // aria-hides everything else), so that action couldn't be clicked,
        // tabbed to or heard. Close the dialog and raise the toast once it
        // has gone, for as long as an undo toast stays.
        afterClose.current = () =>
          toast.error(error, {
            duration: 10_000,
            closeButton: true,
            action: { label: "Open", onClick: () => router.push(`/title/${existingId}`) },
          });
        setShown((s) => ({ ...s, saved: true }));
        setOpen(false);
        return;
      }
      toast.success(unmatched ? "Match saved" : "Match updated");
      setShown((s) => ({ ...s, saved: true }));
      setOpen(false);
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
      else toast.success("Metadata refreshed");
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={(e) => {
          opener.current = e.currentTarget;
          setShown({ name, unmatched, saved: false });
          setOpen(true);
        }}
      >
        <Replace size={16} />
        {unmatched ? "Match to TMDB" : "Change match"}
      </Button>
      {!unmatched && (
        <Button variant="ghost" size="sm" disabled={refreshing} onClick={refresh}>
          {refreshing ? <Spinner /> : <RefreshCw size={16} />}
          Refresh metadata
        </Button>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            ref={contentRef}
            onOpenAutoFocus={(e) => {
              // No autofocus on mobile: keep Radix's default so the on-screen
              // keyboard stays down (AUD-42 mirrors title-controls.tsx's guard).
              if (window.matchMedia("(max-width: 767px)").matches) return;
              e.preventDefault();
              contentRef.current
                ?.querySelector<HTMLInputElement>('input[name="tmdb-search"]')
                ?.focus();
            }}
            onCloseAutoFocus={(e) => {
              if (opener.current) {
                e.preventDefault();
                opener.current.focus();
              }
              // Radix calls this after the dialog has unmounted and restored
              // the page, so a toast raised here is clickable and announced.
              afterClose.current?.();
              afterClose.current = null;
            }}
            className="dialog-content fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none"
          >
            <Dialog.Close
              className="absolute right-3 top-3 -m-3 flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 sm:m-0 sm:min-h-0 sm:min-w-0"
              aria-label="Close"
            >
              <X size={20} />
            </Dialog.Close>
            <Dialog.Title className="text-sm font-semibold">
              {shown.unmatched ? "Find a match for" : "Change match for"} “{shown.name}”
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-muted">
              {shown.unmatched
                ? "Pick the matching title to pull in its poster, cast, and episode list. Your status, rating, notes, tags, and watch history stay put."
                : "Pick the correct title. Your status, rating, notes, tags, and watch history stay put; episode progress resets for a different show."}
            </Dialog.Description>
            <div
              className={
                busy
                  ? "pointer-events-none mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain opacity-60"
                  : "mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain"
              }
            >
              <TmdbSearch
                autoFocus
                onPick={pick}
                placeholder={
                  shown.unmatched ? "Search for this title…" : "Search the correct title…"
                }
              />
            </div>
            {busy && (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <Spinner /> {shown.unmatched ? "Saving match…" : "Updating match…"}
              </p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
