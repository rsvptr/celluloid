"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Heart, Minus, Share2, Tag as TagIcon, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { WatchStatus } from "@/generated/prisma/client";
import { Button, Input, Select, softDisabledClass } from "./ui";
import { useConfirm } from "./confirm-dialog";
import { AnimatePresence, EASE_DRAWER, motion } from "./motion";
import { STATUS_META, STATUS_ORDER } from "@/lib/format";
import {
  bulkAddTag,
  bulkRemoveTag,
  bulkRemoveTitles,
  bulkRestoreTitles,
  bulkSetFavorite,
  bulkSetStatus,
} from "@/lib/actions";
import { undoToast } from "@/lib/undo-toast";
import { cn } from "@/lib/utils";

export function BulkBar({
  open,
  count,
  ids,
  tags,
  onShare,
  onDone,
}: {
  open: boolean;
  count: number;
  ids: string[];
  tags: string[];
  onShare: () => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [newTag, setNewTag] = useState("");
  const [bulkStatus, setBulkStatus] = useState<WatchStatus | "">("");
  // Phone-width disclosure for the secondary actions. The bar used to pack
  // every control into one line: below sm it wrapped to four or five rows and
  // swallowed ~40% of the viewport, and from sm to lg the nowrap scroller cut
  // off everything past the fold — including Remove and Done, because `ml-auto`
  // resolves to zero inside an overflowing flex container, so the exit and the
  // destructive action were both off-screen with nothing to hint at a scroll.
  // Now the bar wraps at every width (no scroller), and on phones only the
  // count, the status select, Remove and Done stay out; the rest lives here.
  const [showMore, setShowMore] = useState(false);
  // Tracks the `open` value last reconciled against showMore, so the
  // render-time adjustment below runs once per actual change (same pattern the
  // Trash count uses in library.tsx) rather than looping.
  const [reconciledOpen, setReconciledOpen] = useState(open);
  const { confirm, dialog } = useConfirm();
  const disabled = pending || count === 0;

  // Leaving select mode closes the disclosure, so the next selection starts from
  // the same compact bar rather than whatever the last one was left expanded to.
  if (open !== reconciledOpen) {
    setReconciledOpen(open);
    if (!open) {
      setShowMore(false);
      setBulkStatus("");
    }
  }

  // On a phone the toast sits 4.5rem from the bottom, which is exactly over this
  // bar's first row for its whole four seconds. Publishing the bar's measured
  // height (the More disclosure changes it) lets the Toaster in (app)/layout.tsx
  // clear it while it is open and fall back to its own offset once it is gone.
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    if (!open || !bar) return;
    const root = document.documentElement;
    const sync = () =>
      root.style.setProperty(
        "--toast-bottom",
        `${Math.ceil(bar.getBoundingClientRect().height) + 8}px`,
      );
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--toast-bottom");
    };
  }, [open]);

  function run(
    fn: () => Promise<{ count?: number; tag?: string; error?: string }>,
    verb: string,
  ) {
    start(async () => {
      // A successful action already returns the re-rendered page. A failed or
      // thrown one returns none, and may follow a partial write, so re-sync.
      try {
        const res = await fn();
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        const changed = res.count ?? 0;
        toast.success(`${verb} ${changed} ${changed === 1 ? "title" : "titles"}`);
      } catch {
        toast.error("Couldn't update those titles. Try again.");
        router.refresh();
      }
    });
  }

  function removeSelected() {
    // Capture the exact selection before leaving select mode; the toast action
    // outlives this bar and must not read whatever ids a later selection holds.
    const removedIds = [...ids];
    start(async () => {
      try {
        const res = await bulkRemoveTitles(removedIds);
        if (res.error) {
          toast.error(res.error);
          router.refresh();
          return;
        }
        const removedCount = res.count ?? 0;
        onDone();
        undoToast(`Removed ${removedCount} ${removedCount === 1 ? "title" : "titles"}`, {
          // One ownership-scoped call for the whole selection; it skips a row
          // already restored through Trash in another tab.
          undo: () => bulkRestoreTitles(removedIds),
          success: `Restored ${removedCount} ${removedCount === 1 ? "title" : "titles"}`,
          failure: "Couldn't restore every title. Check Trash and retry.",
          onError: () => router.refresh(),
        });
      } catch {
        toast.error("Couldn't remove those titles. Try again.");
        router.refresh();
      }
    });
  }

  function applyBulkStatus() {
    if (disabled || !bulkStatus) return;
    const status = bulkStatus;
    run(async () => {
      const result = await bulkSetStatus(ids, status);
      if (!result.error) setBulkStatus("");
      return result;
    }, "Updated");
  }

  return (
    <>
      {dialog}
      <AnimatePresence>
      {open && (
        <motion.div
          ref={barRef}
          // z-[45]: above the mobile tab bar (nav.tsx, z-40, md:hidden) — selection
          // mode is a transient modal-ish state that's meant to cover it — but
          // below dialogs/command palette (z-50) so a confirm dialog or the share
          // dialog opened from here still renders on top.
          className="fixed inset-x-0 bottom-0 z-[45] px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          data-motion-enter
          // EM-11: rise its full height (80px left a 132px phone bar half on
          // screen) on the drawer curve, and leave faster than it came.
          initial={{ y: "100%", opacity: 0 }}
          animate={{ y: 0, opacity: 1, transition: { duration: 0.25, ease: EASE_DRAWER } }}
          exit={{ y: "100%", opacity: 0, transition: { duration: 0.2, ease: EASE_DRAWER } }}
        >
          {/* max-w-5xl (was 4xl): the full control set measures ~930px, so the
              wider cap is what lets a desktop still show it on a single row. */}
          <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 rounded-2xl bg-surface/95 p-2.5 shadow-xl ring-1 ring-line backdrop-blur-md">
            <span className="shrink-0 px-2 text-sm font-medium tabular-nums">
              {count} selected
            </span>

            <Select
              value={bulkStatus}
              aria-disabled={disabled}
              onChange={(e) => {
                // aria-disabled doesn't stop a native select from changing, so
                // guard here (the controlled value then snaps back).
                if (disabled) return;
                setBulkStatus(e.target.value as WatchStatus | "");
              }}
              aria-label="Set status for selected titles"
              className={cn("w-auto min-h-11 shrink-0", softDisabledClass)}
            >
              <option value="">Set status…</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              aria-disabled={disabled || !bulkStatus}
              onClick={applyBulkStatus}
              className={cn("min-h-11 shrink-0", softDisabledClass)}
            >
              Apply
            </Button>

            <button
              type="button"
              onClick={() => setShowMore((v) => !v)}
              aria-expanded={showMore}
              aria-controls="bulk-more-actions"
              className="focus-ring flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm text-muted ring-1 ring-line press hover:text-foreground sm:hidden"
            >
              More
              <ChevronDown
                size={16}
                aria-hidden
                className={cn("transition-transform", showMore && "rotate-180")}
              />
            </button>

            {/* Secondary actions. Below sm this is the disclosure: a full-width
                row that wraps directly under the More button controlling it. It
                used to be pulled below Remove/Done with `order-last` so those two
                never moved, but that left tab order and screen-reader order
                disagreeing with the screen — the panel was read before the two
                buttons it appeared underneath. Sitting next to its trigger costs
                Remove/Done one row while the panel is open, and is where a
                disclosure's content belongs anyway. Rules on both edges keep it
                legible as its own block between the two rows. From sm up the
                breakpoint utilities win outright, so it sits inline whatever the
                disclosure was last left at. */}
            <div
              id="bulk-more-actions"
              className={cn(
                "w-full flex-wrap items-center gap-2 border-y border-line py-2.5 sm:w-auto sm:border-0 sm:py-0",
                showMore ? "flex" : "hidden sm:flex",
              )}
            >
              <div className="flex items-center gap-1">
                <Input
                  list="bulk-tags"
                  value={newTag}
                  onChange={(e) => setNewTag(e.target.value)}
                  placeholder="Add tag…"
                  aria-disabled={disabled}
                  aria-label="Tag to add or remove"
                  className={cn("h-9 min-h-11 w-32 sm:min-h-0", softDisabledClass)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !disabled && newTag.trim()) {
                      run(() => bulkAddTag(ids, newTag.trim()), "Tagged");
                      setNewTag("");
                    }
                  }}
                />
                <datalist id="bulk-tags">
                  {tags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={disabled || !newTag.trim()}
                  onClick={() => {
                    if (disabled || !newTag.trim()) return;
                    run(() => bulkAddTag(ids, newTag.trim()), "Tagged");
                    setNewTag("");
                  }}
                  title="Add this tag to selected"
                  aria-label="Add this tag to selected"
                  className={cn("min-h-11 min-w-11 sm:min-w-0", softDisabledClass)}
                >
                  <TagIcon size={16} />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  aria-disabled={disabled || !newTag.trim()}
                  onClick={() => {
                    if (disabled || !newTag.trim()) return;
                    run(() => bulkRemoveTag(ids, newTag.trim()), "Untagged");
                    setNewTag("");
                  }}
                  title="Remove this tag from selected"
                  aria-label="Remove this tag from selected"
                  className={cn("min-h-11 min-w-11 sm:min-w-0", softDisabledClass)}
                >
                  <Minus size={16} />
                </Button>
              </div>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  run(() => bulkSetFavorite(ids, true), "Favorited");
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Heart size={16} /> Favorite
              </Button>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  run(() => bulkSetFavorite(ids, false), "Unfavorited");
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Heart size={16} className="text-faint" /> Unfavorite
              </Button>

              <Button
                size="sm"
                variant="secondary"
                aria-disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onShare();
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Share2 size={16} /> Share
              </Button>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Button
                size="sm"
                variant="danger"
                aria-disabled={disabled}
                onClick={async () => {
                  if (disabled) return;
                  if (
                    !(await confirm({
                      title: `Remove ${count} ${count === 1 ? "title" : "titles"}?`,
                      body:
                        count === 1
                          ? "This moves it to Trash. You can restore it from there."
                          : "This moves them to Trash. You can restore them from there.",
                      confirmLabel: "Remove",
                      destructive: true,
                    }))
                  )
                    return;
                  removeSelected();
                }}
                className={cn("min-h-11", softDisabledClass)}
              >
                <Trash2 size={16} /> Remove
              </Button>

              <button
                onClick={onDone}
                className="focus-ring flex min-h-11 items-center rounded-lg px-2.5 py-1.5 text-sm text-muted hover:text-foreground sm:min-h-8"
              >
                Done
              </button>
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>
    </>
  );
}
