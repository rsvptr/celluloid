"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Button, Card, Input } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteWatchEvent, updateWatchEvent } from "@/lib/actions";
import { fullDate } from "@/lib/format";

export interface WatchEventVM {
  id: string;
  kind: "TITLE_COMPLETED" | "REWATCH";
  /** ISO instant; the date input needs the YYYY-MM-DD prefix. */
  occurredAt: string;
  note: string | null;
}

function kindLabel(kind: WatchEventVM["kind"]): string {
  return kind === "REWATCH" ? "Rewatched" : "Watched";
}

/**
 * The History list, with per-row correction. Watch events are append-only by
 * design — they are the record stats and streaks are built from — but "append
 * only" shouldn't mean "wrong forever": a viewing logged on the wrong day, or
 * logged twice by a double-tap, previously had no route to repair from inside
 * the app at all.
 *
 * Editing and deleting both re-derive the title's watchedAt server-side, so the
 * cache can't drift away from the log.
 */
export function WatchHistoryList({
  events,
  total,
}: {
  events: WatchEventVM[];
  total: number;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const { confirm, dialog } = useConfirm();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftDate, setDraftDate] = useState("");
  const [draftNote, setDraftNote] = useState("");

  // Opening the form unmounts the Edit button that was focused, and focus then
  // falls back to <body> — a keyboard or screen-reader user loses their place in
  // the list entirely. So focus moves to the form's first field when it opens and
  // returns to the row's own Edit button when it closes, whether by cancel or by
  // save. The buttons are collected by id because the row that has to receive
  // focus is the one that no longer exists at the moment the form closes.
  const dateFieldRef = useRef<HTMLInputElement>(null);
  const editButtons = useRef<Map<string, HTMLButtonElement | null>>(new Map());
  const restoreFocusId = useRef<string | null>(null);

  useEffect(() => {
    if (editingId) {
      dateFieldRef.current?.focus();
      return;
    }
    const id = restoreFocusId.current;
    if (!id) return;
    restoreFocusId.current = null;
    editButtons.current.get(id)?.focus();
  }, [editingId]);

  function beginEdit(event: WatchEventVM) {
    setEditingId(event.id);
    setDraftDate(event.occurredAt.slice(0, 10));
    setDraftNote(event.note ?? "");
  }

  function closeEdit(event: WatchEventVM) {
    restoreFocusId.current = event.id;
    setEditingId(null);
  }

  function save(event: WatchEventVM) {
    if (!draftDate) return;
    start(async () => {
      const res = await updateWatchEvent(event.id, {
        // The server reads a bare YYYY-MM-DD as UTC midnight, so submitting the
        // truncated day rewrote the event's time even when only the note had
        // changed — west of UTC that drags the watch onto the previous local day,
        // moving it in the heatmap and potentially breaking a streak. An untouched
        // day therefore sends the original instant straight back (the action's
        // date field accepts a full ISO string); a day the owner actually changed
        // still submits as the plain date it was picked as.
        occurredAt:
          draftDate === event.occurredAt.slice(0, 10) ? event.occurredAt : draftDate,
        note: draftNote,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      closeEdit(event);
      toast.success("Watch updated");
      router.refresh();
    });
  }

  async function remove(event: WatchEventVM) {
    if (
      !(await confirm({
        title: "Remove this watch?",
        body:
          total === 1
            ? "This is the only recorded viewing, so the title will no longer have a watch date. Its status is left as it is."
            : "This removes it from your history, stats and streaks. No undo.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    start(async () => {
      const res = await deleteWatchEvent(event.id);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success("Watch removed");
      router.refresh();
    });
  }

  return (
    <>
      {dialog}
      <Card variant="inset" className="flex flex-col gap-3 p-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-faint">
          History
        </h2>
        <ul className="flex flex-col gap-3">
          {events.map((event) => (
            <li key={event.id} className="text-sm">
              {editingId === event.id ? (
                <div className="flex flex-col gap-2">
                  <input
                    ref={dateFieldRef}
                    type="date"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                    aria-label="Date watched"
                    className="h-11 w-full rounded-lg bg-surface-2 px-3 text-base text-foreground ring-1 ring-line-strong focus:outline-none focus:ring-2 focus:ring-brand/60 sm:h-10 sm:text-sm [color-scheme:dark]"
                  />
                  <Input
                    value={draftNote}
                    onChange={(e) => setDraftNote(e.target.value)}
                    placeholder="Note (optional)"
                    aria-label="Note"
                    maxLength={500}
                  />
                  <div className="flex justify-end gap-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => closeEdit(event)}
                      disabled={pending}
                    >
                      <X size={14} /> Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => save(event)}
                      disabled={pending || !draftDate}
                    >
                      <Check size={14} /> Save
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground/90">
                      {fullDate(event.occurredAt)} · {kindLabel(event.kind)}
                    </p>
                    {event.note && (
                      <p className="mt-0.5 break-words text-xs text-muted">
                        {event.note}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center">
                    <button
                      type="button"
                      ref={(el) => {
                        const buttons = editButtons.current;
                        buttons.set(event.id, el);
                        // Braced so the cleanup returns undefined: a bare
                        // `delete` expression hands React the Map's boolean,
                        // which a ref callback's cleanup contract forbids.
                        return () => {
                          buttons.delete(event.id);
                        };
                      }}
                      onClick={() => beginEdit(event)}
                      disabled={pending}
                      aria-label={`Edit the watch on ${fullDate(event.occurredAt)}`}
                      className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint transition-colors hover:text-foreground disabled:opacity-50 sm:min-h-8 sm:min-w-8"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(event)}
                      disabled={pending}
                      aria-label={`Remove the watch on ${fullDate(event.occurredAt)}`}
                      className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint transition-colors hover:text-rose-300 disabled:opacity-50 sm:min-h-8 sm:min-w-8"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {total > events.length && (
          <p className="border-t border-line pt-3 text-xs text-faint">
            {total} watches total · showing the {events.length} most recent
          </p>
        )}
      </Card>
    </>
  );
}
