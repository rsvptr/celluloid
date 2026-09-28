"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { deleteWatchEvent, updateWatchEvent } from "@/lib/actions";
import { fullDate } from "@/lib/format";
// Same page, same dates: the "Date watched" field and this list have to resolve
// a stored instant to the same calendar day, so they share one implementation.
import { dayInZone } from "./title-controls";

export interface WatchEventVM {
  id: string;
  kind: "TITLE_COMPLETED" | "REWATCH";
  /** ISO instant; the date input needs it as the account zone's calendar day. */
  occurredAt: string;
  note: string | null;
}

function kindLabel(kind: WatchEventVM["kind"]): string {
  return kind === "REWATCH" ? "Rewatched" : "Watched";
}

/**
 * fullDate, read in the account's zone. A viewing entered as a calendar day is
 * stored as that day's start in the account zone, so naming it in UTC prints
 * the day before east of UTC and disagrees with the heatmap (AUD-05).
 */
function fullDateInZone(iso: string, timeZone: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone,
    });
  } catch {
    return fullDate(iso);
  }
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
  timeZone = "UTC",
}: {
  events: WatchEventVM[];
  total: number;
  /** The account's IANA zone (User.timeZone), the zone the server resolved
   *  these dates in and stats bucket them in. */
  timeZone?: string;
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

  // Removing a row unmounts the button that was focused and Chrome drops focus
  // to <body>, so the next Tab restarts at the skip link. Once the refreshed
  // list arrives, focus goes to the row that took its place — its Edit button,
  // the non-destructive control, reusing the map above.
  const focusAfterRemoveId = useRef<string | null>(null);

  useEffect(() => {
    const id = focusAfterRemoveId.current;
    if (!id) return;
    focusAfterRemoveId.current = null;
    editButtons.current.get(id)?.focus();
  }, [events]);

  function beginEdit(event: WatchEventVM) {
    setEditingId(event.id);
    setDraftDate(dayInZone(event.occurredAt, timeZone));
    setDraftNote(event.note ?? "");
  }

  function closeEdit(event: WatchEventVM) {
    restoreFocusId.current = event.id;
    setEditingId(null);
  }

  /** The row that takes `event`'s place once it leaves the list. */
  function neighbourOf(event: WatchEventVM): string | null {
    const index = events.findIndex((e) => e.id === event.id);
    return events[index + 1]?.id ?? events[index - 1]?.id ?? null;
  }

  // Deleted in another tab since this list rendered: the action says "Watch
  // not found." and writes nothing, so nothing re-renders. Close the editor
  // and refresh, so the stale row goes rather than lingering until a
  // navigation (P7X-9).
  function dropStaleRow(event: WatchEventVM) {
    focusAfterRemoveId.current = neighbourOf(event);
    setEditingId(null);
    router.refresh();
  }

  function save(event: WatchEventVM) {
    if (!draftDate) return;
    start(async () => {
      const res = await updateWatchEvent(event.id, {
        // The server resolves a bare YYYY-MM-DD to that day's start in the
        // account zone, so submitting the truncated day would rewrite the
        // event's time of day even when only the note had changed. An untouched
        // day therefore sends the original instant straight back (the action's
        // date field accepts a full ISO string and passes it through); a day the
        // owner actually changed still submits as the plain date it was picked
        // as. The comparison has to use the same zone the field was filled from.
        occurredAt:
          draftDate === dayInZone(event.occurredAt, timeZone)
            ? event.occurredAt
            : draftDate,
        note: draftNote,
      });
      if (res.error) {
        toast.error(res.error);
        if (res.error === "Watch not found.") dropStaleRow(event);
        return;
      }
      closeEdit(event);
      toast.success("Watch updated");
    });
  }

  async function remove(event: WatchEventVM) {
    if (
      !(await confirm({
        title: "Remove this watch?",
        body:
          total === 1
            ? "This is the only recorded viewing. It comes off your history, stats and streaks, but the title keeps its watch date and status. No undo."
            : "This removes it from your history, stats and streaks, and the title's watch date moves back to the latest remaining viewing. No undo.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    const neighbour = neighbourOf(event);
    start(async () => {
      const res = await deleteWatchEvent(event.id);
      if (res.error) {
        toast.error(res.error);
        if (res.error === "Watch not found.") dropStaleRow(event);
        return;
      }
      focusAfterRemoveId.current = neighbour;
      toast.success("Watch removed");
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
                <form
                  method="post"
                  className="flex flex-col gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (pending) return;
                    save(event);
                  }}
                >
                  <input
                    ref={dateFieldRef}
                    type="date"
                    value={draftDate}
                    onChange={(e) => setDraftDate(e.target.value)}
                    aria-label="Date watched"
                    className="h-11 w-full rounded-lg bg-surface-2 px-3 text-base text-foreground ring-1 ring-line-strong focus:outline-hidden focus:ring-2 focus:ring-brand/60 forced-colors:border sm:h-10 sm:text-sm [color-scheme:dark]"
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
                      <X size={16} /> Cancel
                    </Button>
                    <Button
                      type="submit"
                      size="sm"
                      variant="primary"
                      disabled={pending || !draftDate}
                    >
                      <Check size={16} /> Save
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground/90">
                      {fullDateInZone(event.occurredAt, timeZone)} · {kindLabel(event.kind)}
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
                      onClick={() => {
                        if (pending) return;
                        beginEdit(event);
                      }}
                      // aria-disabled, not disabled: Chrome drops focus to
                      // <body> the moment the focused button is disabled, which
                      // is exactly what a pending remove or save does to the row
                      // the keyboard is sitting on.
                      aria-disabled={pending}
                      aria-label={`Edit the watch on ${fullDateInZone(event.occurredAt, timeZone)}`}
                      className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint press hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:min-h-8 sm:min-w-8"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (pending) return;
                        void remove(event);
                      }}
                      aria-disabled={pending}
                      aria-label={`Remove the watch on ${fullDateInZone(event.occurredAt, timeZone)}`}
                      className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-md text-faint press hover:text-rose-300 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 sm:min-h-8 sm:min-w-8"
                    >
                      <Trash2 size={16} />
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
