"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TrashedTitle } from "@/lib/data";
import { Button, softDisabledClass } from "./ui";
import { Poster } from "./poster";
import { useConfirm } from "./confirm-dialog";
import { fullDate } from "@/lib/format";
import { emptyTrash, purgeTitle, restoreTitle } from "@/lib/actions";
import { cn } from "@/lib/utils";

export function TrashView({
  trashed,
  onExit,
}: {
  trashed: TrashedTitle[];
  onExit: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { confirm, dialog } = useConfirm();
  // Restoring or deleting a row unmounts the button that was focused, so focus
  // has to be placed deliberately once the refreshed list arrives: on the row
  // that took its place, or the row above when the last one went. Rows are
  // collected by id because the row that must receive focus is not the one that
  // was clicked. ui.tsx's Button takes no ref, so the row element is what is
  // held and its first control (Restore) is what gets focused.
  const rowRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const focusAfterRemovalId = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRemovalId.current;
    if (!id) return;
    focusAfterRemovalId.current = null;
    rowRefs.current.get(id)?.querySelector("button")?.focus();
  }, [trashed]);

  /** The row focus should land on once `id`'s row is gone. */
  function neighbourRowId(id: string): string | null {
    const index = trashed.findIndex((item) => item.id === id);
    if (index === -1) return null;
    return trashed[index + 1]?.id ?? trashed[index - 1]?.id ?? null;
  }

  function restore(item: TrashedTitle) {
    const neighbour = neighbourRowId(item.id);
    start(async () => {
      // A successful action returns the re-rendered page; re-sync from the
      // server only when it failed, so a failed action can't leave a stale row.
      try {
        const res = await restoreTitle(item.id);
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        focusAfterRemovalId.current = neighbour;
        toast.success(`Restored ${item.name}`);
      } catch {
        toast.error("Couldn't restore that title. Try again.");
        router.refresh();
      }
    });
  }

  async function purge(item: TrashedTitle) {
    if (
      !(await confirm({
        title: `Delete ${item.name} forever?`,
        body: "This permanently deletes it. No undo.",
        confirmLabel: "Delete forever",
        destructive: true,
      }))
    )
      return;
    const neighbour = neighbourRowId(item.id);
    start(async () => {
      try {
        const res = await purgeTitle(item.id);
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        focusAfterRemovalId.current = neighbour;
        toast.success(`Deleted ${item.name}`);
      } catch {
        toast.error("Couldn't delete that title. Try again.");
        router.refresh();
      }
    });
  }

  async function purgeAll() {
    const n = trashed.length;
    if (
      !(await confirm({
        title: `Delete all ${n} ${n === 1 ? "title" : "titles"} forever?`,
        body: "This permanently deletes everything in Trash, with all its ratings, notes and episode progress. No undo.",
        confirmLabel: "Delete all forever",
        destructive: true,
      }))
    )
      return;
    start(async () => {
      try {
        const res = await emptyTrash();
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        const deletedCount = res.count ?? 0;
        toast.success(
          `Deleted ${deletedCount} ${deletedCount === 1 ? "title" : "titles"}`,
        );
      } catch {
        toast.error("Couldn't empty Trash. Try again.");
        router.refresh();
      }
    });
  }

  return (
    <>
      {dialog}
      <div className="flex flex-col gap-4 pb-24">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Trash</h1>
            <span className="shrink-0 text-xs tabular-nums text-muted">
              {trashed.length} {trashed.length === 1 ? "title" : "titles"}
            </span>
          </div>
          <button
            type="button"
            onClick={onExit}
            className="focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-sm text-muted ring-1 ring-line transition-colors hover:text-foreground sm:min-h-8"
          >
            <ArrowLeft size={16} /> Back to library
          </button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted">
            Restore a title to bring it back with your ratings and notes, or delete it forever.
          </p>
          {trashed.length > 1 && (
            <Button
              size="sm"
              variant="danger"
              aria-disabled={pending}
              onClick={() => {
                if (pending) return;
                void purgeAll();
              }}
              className={cn("shrink-0", softDisabledClass)}
            >
              <Trash2 size={16} /> Empty trash
            </Button>
          )}
        </div>
        {trashed.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line py-20 text-center">
            <p className="text-sm text-muted">Trash is empty.</p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-line overflow-hidden rounded-[var(--radius-card)] ring-1 ring-line">
            {trashed.map((it) => (
              <TrashRow
                key={it.id}
                item={it}
                busy={pending}
                rowRef={(el) => {
                  const rows = rowRefs.current;
                  rows.set(it.id, el);
                  return () => {
                    rows.delete(it.id);
                  };
                }}
                onRestore={() => restore(it)}
                onPurge={() => purge(it)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TrashRow({
  item,
  busy,
  rowRef,
  onRestore,
  onPurge,
}: {
  item: TrashedTitle;
  busy: boolean;
  rowRef: React.Ref<HTMLDivElement>;
  onRestore: () => void;
  onPurge: () => void;
}) {
  return (
    <div ref={rowRef} className="flex items-center gap-3 bg-surface px-3 py-2.5">
      <div className="w-9 shrink-0">
        <Poster
          path={item.posterPath}
          name={item.name}
          decorative
          mediaType={item.mediaType}
          size="w92"
          sizes="36px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={item.name}>
          {item.name}
        </div>
        <div className="truncate text-xs text-muted">
          {item.mediaType === "TV" ? "TV" : "Movie"} · Deleted {fullDate(item.deletedAt)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            onRestore();
          }}
          className={softDisabledClass}
        >
          <RotateCcw size={16} /> Restore
        </Button>
        <Button
          size="sm"
          variant="danger"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            onPurge();
          }}
          className={softDisabledClass}
        >
          <Trash2 size={16} />
          <span className="hidden sm:inline">Delete forever</span>
          <span className="sm:hidden">Delete</span>
        </Button>
      </div>
    </div>
  );
}
