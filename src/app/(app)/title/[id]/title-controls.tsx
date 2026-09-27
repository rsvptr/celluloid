"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Heart, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { WatchStatus } from "@/generated/prisma/client";
import { Button, Card, Input, Select, Textarea } from "@/components/ui";
import { RatingStars } from "@/components/rating-stars";
import { useConfirm } from "@/components/confirm-dialog";
import { STATUS_META, STATUS_ORDER } from "@/lib/format";
import {
  logWatch,
  removeTitle,
  restoreTitle,
  undoWatchedTransition,
  updateTitle,
} from "@/lib/actions";
import { undoToast } from "@/lib/undo-toast";
import { cn } from "@/lib/utils";

type NotesStatus = "idle" | "saving" | "saved" | "error";

const STATUS_NAVIGATION_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** The four non-debounced fields. Tracked as a group so one serialized queue can
 * persist them in order; status joins the queue on blur/Enter. watchedAt is held
 * in the date input's yyyy-mm-dd form (or "" when cleared), not the ISO prop form. */
type ImmediateValues = {
  status: WatchStatus;
  rating: number | null;
  favorite: boolean;
  watchedAt: string;
};

export function TitleControls({
  id,
  status,
  rating,
  notes,
  favorite,
  watchedAt,
  watchCount,
  timeZone = "UTC",
}: {
  id: string;
  status: WatchStatus;
  rating: number | null;
  notes: string | null;
  favorite: boolean;
  watchedAt: string | null;
  watchCount: number;
  /** The account's IANA zone (User.timeZone). "Date watched" is stored as an
   *  instant but entered and read as a calendar day, so it has to be shown in
   *  the same zone the server resolved it in and stats bucket it in (AUD-05). */
  timeZone?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { confirm, dialog } = useConfirm();

  // --- Log-watch dialog -----------------------------------------------------
  const [logOpen, setLogOpen] = useState(false);
  const [logDate, setLogDate] = useState("");
  const [logNote, setLogNote] = useState("");
  const [isLogging, startLog] = useTransition();
  const logDateId = useId();
  const logNoteId = useId();
  const logContentRef = useRef<HTMLDivElement>(null);
  const logTriggerRef = useRef<HTMLButtonElement | null>(null);

  function openLog(e: React.MouseEvent<HTMLButtonElement>) {
    logTriggerRef.current = e.currentTarget;
    setLogDate(todayLocalDate());
    setLogNote("");
    setLogOpen(true);
  }

  function submitLog() {
    if (!logDate) return;
    startLog(async () => {
      const res = await logWatch(id, {
        occurredAt: logDate,
        note: logNote.trim() || null,
      });
      if (res?.error) {
        toast.error(res.error);
        return;
      }
      // Prefer the server's fresh count; fall back to an optimistic +1.
      const n = res?.watchCount ?? watchCount + 1;
      toast.success(`Logged. Watched ${n} ${n === 1 ? "time" : "times"}.`);
      setLogOpen(false);
      router.refresh();
    });
  }

  const statusId = useId();
  const notesId = useId();
  // Native selects fire `change` while arrowing on several desktop browsers.
  // This transient flag distinguishes that navigation from a pointer/native-
  // picker choice, which should retain immediate-save behaviour.
  const statusNavigationRef = useRef(false);
  // True while an arrow-key pick is only staged: it shows in the select but
  // stays out of latestImmediateRef until Enter or blur commits it. Written
  // straight into the queue, a save already in flight (a rating click, say)
  // sent it on its next pass without that confirmation.
  const statusStagedRef = useRef(false);
  const [localStatus, setLocalStatus] = useState(status);
  const [localRating, setLocalRating] = useState(rating);
  const [localFav, setLocalFav] = useState(favorite);
  const [localWatchedAt, setLocalWatchedAt] = useState(dayInZone(watchedAt, timeZone));
  const [localNotes, setLocalNotes] = useState(notes ?? "");
  const [savedNotes, setSavedNotes] = useState(notes ?? "");
  const [notesStatus, setNotesStatus] = useState<NotesStatus>("idle");

  const notesDirty = localNotes !== savedNotes;

  // --- Immediate-field autosave queue (status / rating / favorite / date) ----
  // Rating, favorite and date commit instantly; status commits on Enter or blur
  // so browsing a native select with arrow keys cannot trigger a mass TV update.
  // Like notes, all four serialize through one
  // drain loop so rapid edits can never persist out of order. `latest` holds the
  // current optimistic value of each field; `confirmed` holds the last value the
  // server accepted. A field is dirty while the two differ. Newer edits to a
  // field coalesce (latest wins), and a failed save rolls a field back to
  // `confirmed` only when the field still holds the value we tried to persist.
  const latestImmediateRef = useRef<ImmediateValues>({
    status,
    rating,
    favorite,
    watchedAt: dayInZone(watchedAt, timeZone),
  });
  const confirmedImmediateRef = useRef<ImmediateValues>({
    status,
    rating,
    favorite,
    watchedAt: dayInZone(watchedAt, timeZone),
  });
  const immediateSavingRef = useRef(false);

  // CP-06: resync the immediate-commit fields (status/rating/favorite/date) when
  // router.refresh() delivers fresh server props — e.g. the server auto-stamps
  // watchedAt when a title is marked WATCHED, and the date input must reflect it
  // instead of staying blank. Compare against the props we last applied, never
  // against local state, so an in-flight optimistic edit is never reverted; skip
  // while a mutation is pending (lastSyncedRef is left untouched so the change is
  // re-detected and applied once the transition settles). Refs are only read and
  // written inside this effect (never during render), per react-hooks/refs.
  const lastSyncedRef = useRef({ status, rating, favorite, watchedAt });
  useEffect(() => {
    if (isPending) return;
    const last = lastSyncedRef.current;
    if (
      last.status === status &&
      last.rating === rating &&
      last.favorite === favorite &&
      last.watchedAt === watchedAt
    ) {
      return;
    }
    lastSyncedRef.current = { status, rating, favorite, watchedAt };
    const wa = dayInZone(watchedAt, timeZone);
    // Keep a staged arrow-key pick on screen; Enter or blur still commits it.
    if (!statusStagedRef.current) setLocalStatus(status);
    setLocalRating(rating);
    setLocalFav(favorite);
    setLocalWatchedAt(wa);
    // Re-baseline the immediate-field queue to server truth so the next edit
    // diffs against — and rolls back to — the fresh value. Safe here because
    // this branch only runs while no mutation is pending (see !isPending), so it
    // can't stomp an in-flight optimistic edit.
    latestImmediateRef.current = { status, rating, favorite, watchedAt: wa };
    confirmedImmediateRef.current = { status, rating, favorite, watchedAt: wa };
  }, [status, rating, favorite, watchedAt, timeZone, isPending]);

  // Serialized drain for the immediate fields (see refs above). Only one
  // updateTitle is ever in flight; it carries every currently-dirty field, and
  // the loop re-checks after each await so a value changed mid-save is sent next
  // (latest wins). A save only lands when latest still equals what we sent; a
  // field re-edited mid-flight is never rolled back and its newer value is
  // re-sent on the following pass. One toast per drain, only if a rollback
  // actually happened (a superseded-then-recovered value must not raise a false
  // alarm). The loop converges because each pass either confirms or rolls back
  // every field it sends, and only an edit made during that pass's await keeps a
  // field dirty — impossible to sustain without continuous typing.
  const drainImmediate = useCallback(async () => {
    if (immediateSavingRef.current) return; // a drain is already running
    immediateSavingRef.current = true;
    let errorMessage: string | null = null;
    let watchedUndo: {
      titleId: string;
      occurredAt: string;
      restoreWatchedAt: string | null;
    } | null = null;
    try {
      while (
        (["status", "rating", "favorite", "watchedAt"] as const).some(
          (f) => latestImmediateRef.current[f] !== confirmedImmediateRef.current[f],
        )
      ) {
        const latest = latestImmediateRef.current;
        const confirmed = confirmedImmediateRef.current;
        // Snapshot exactly the fields that differ: `patch` in updateTitle's wire
        // shape, `sent` in local form for the current-value / rollback check.
        const patch: Parameters<typeof updateTitle>[1] = {};
        const sent: Partial<ImmediateValues> = {};
        if (latest.status !== confirmed.status) {
          patch.status = latest.status;
          sent.status = latest.status;
        }
        if (latest.rating !== confirmed.rating) {
          patch.rating = latest.rating;
          sent.rating = latest.rating;
        }
        if (latest.favorite !== confirmed.favorite) {
          patch.favorite = latest.favorite;
          sent.favorite = latest.favorite;
        }
        if (latest.watchedAt !== confirmed.watchedAt) {
          patch.watchedAt = latest.watchedAt || null;
          sent.watchedAt = latest.watchedAt;
        }
        try {
          const res = await updateTitle(id, patch);
          if (res.error) throw new Error(res.error, { cause: "action" });
          if (sent.status === "WATCHED" && res.undo) watchedUndo = res.undo;
          // Confirm only what we sent; anything changed during the await stays
          // dirty and the loop sends it on the next pass.
          Object.assign(confirmedImmediateRef.current, sent);
        } catch (e) {
          // Roll a field back only when its optimistic value is still the one we
          // tried to persist — a newer edit since then owns the field, stays
          // dirty and is re-sent next pass rather than clobbered.
          const cur = latestImmediateRef.current;
          const base = confirmedImmediateRef.current;
          let didRevert = false;
          if (sent.status !== undefined && cur.status === sent.status) {
            cur.status = base.status;
            setLocalStatus(base.status);
            didRevert = true;
          }
          if (sent.rating !== undefined && cur.rating === sent.rating) {
            cur.rating = base.rating;
            setLocalRating(base.rating);
            didRevert = true;
          }
          if (sent.favorite !== undefined && cur.favorite === sent.favorite) {
            cur.favorite = base.favorite;
            setLocalFav(base.favorite);
            didRevert = true;
          }
          if (sent.watchedAt !== undefined && cur.watchedAt === sent.watchedAt) {
            cur.watchedAt = base.watchedAt;
            setLocalWatchedAt(base.watchedAt);
            didRevert = true;
          }
          // If nothing was rolled back, every field we sent was superseded
          // mid-flight; leave those newer values dirty and let the loop re-send
          // them (it can't spin without a fresh edit each pass). Only raise the
          // toast when a value was actually rolled back.
          if (didRevert) {
            // Only an action-supplied `{ error }` string is safe to show; any
            // other exception (transport failure, redacted server fault) gets
            // the controlled fallback instead of its raw message.
            errorMessage =
              e instanceof Error && e.cause === "action" && e.message
                ? e.message
                : "Couldn't save that change.";
          }
        }
      }
    } finally {
      immediateSavingRef.current = false;
    }
    if (errorMessage) toast.error(errorMessage);
    if (watchedUndo) {
      const undo = watchedUndo;
      undoToast("Marked watched", {
        undo: () =>
          undoWatchedTransition(undo.titleId, undo.occurredAt, undo.restoreWatchedAt),
        success: "Watched change undone",
        failure: "Couldn't undo that watched change. Try again.",
        onError: () => router.refresh(),
      });
    }
    router.refresh();
  }, [id, router]);

  // Kick the drain inside a transition so isPending stays true for its whole run
  // — the prop-resync guard above keys off isPending to avoid clobbering an
  // in-flight edit. If a drain is already running it simply absorbs the new value.
  const commitImmediate = useCallback(() => {
    if (immediateSavingRef.current) return;
    startTransition(async () => {
      await drainImmediate();
    });
  }, [drainImmediate]);

  // --- Notes autosave -------------------------------------------------------
  // Refs drive the async orchestration so the drain loop always reads the
  // freshest text (and the last saved value) without stale-closure hazards.
  const latestNotesRef = useRef(localNotes);
  const savedNotesRef = useRef(savedNotes);
  const savingRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Serialize saves through a single drain loop: only one write is ever in
  // flight and it always carries the latest text, so a stale save can never land
  // after a newer one (a stronger guarantee than tagging requests with a
  // sequence). The loop re-checks the latest text after each await, so anything
  // typed while a save was in flight is picked up before we settle on "Saved".
  const drainSaves = useCallback(async () => {
    if (savingRef.current) return; // a drain is already running; it will catch up
    if (latestNotesRef.current === savedNotesRef.current) return; // nothing to save
    savingRef.current = true;
    try {
      while (latestNotesRef.current !== savedNotesRef.current) {
        const content = latestNotesRef.current;
        setNotesStatus("saving");
        const res = await updateTitle(id, { notes: content });
        if (res.error) throw new Error(res.error);
        savedNotesRef.current = content;
        setSavedNotes(content);
      }
      setNotesStatus("saved");
      router.refresh();
    } catch {
      // Keep the dirty text (savedNotesRef stays behind latest) and surface a
      // retry rather than silently dropping the edit.
      setNotesStatus("error");
    } finally {
      savingRef.current = false;
    }
  }, [id, router]);

  // Flush immediately (blur / retry): cancel the pending debounce and save now.
  const flushNotes = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void drainSaves();
  }, [drainSaves]);

  // Debounce ~800ms after the last keystroke.
  const scheduleSave = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void drainSaves();
    }, 800);
  }, [drainSaves]);

  // CP-06 for notes: adopt a server-changed value only when the field is clean
  // and no save is in flight, so typing or an in-flight autosave is never
  // clobbered. Notes change only through this component, so our own autosave
  // round-tripping the value back is a no-op here, and a value we skip is one we
  // are about to (re)write anyway.
  useEffect(() => {
    const incoming = notes ?? "";
    if (incoming === savedNotesRef.current) return; // our own save, or unchanged
    if (savingRef.current) return; // a save is in flight
    if (latestNotesRef.current !== savedNotesRef.current) return; // dirty edits
    savedNotesRef.current = incoming;
    latestNotesRef.current = incoming;
    setSavedNotes(incoming);
    setLocalNotes(incoming);
  }, [notes]);

  // Warn on tab close only while a save is in flight or edits are unsaved.
  const notesBusy = notesDirty || notesStatus === "saving";
  useEffect(() => {
    if (!notesBusy) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [notesBusy]);

  // Best-effort flush on unmount so a fast in-app navigation inside the debounce
  // window doesn't silently drop edits. Guarded so a clean unmount does nothing.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!savingRef.current && latestNotesRef.current !== savedNotesRef.current) {
        void updateTitle(id, { notes: latestNotesRef.current }).catch(() => {});
      }
    };
  }, [id]);

  return (
    <>
      {dialog}
      <Dialog.Root open={logOpen} onOpenChange={setLogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-[dialog-overlay-in_0.2s_ease-out]" />
          <Dialog.Content
            ref={logContentRef}
            onOpenAutoFocus={(e) => {
              // No autofocus on mobile: move focus to the dialog container rather
              // than the date input, so the on-screen keyboard stays down while
              // the dialog is still announced and focus is trapped inside it.
              // Desktop lands on the date field: the Close button is the first
              // tabbable, so Radix's default would focus that instead.
              e.preventDefault();
              if (window.matchMedia("(max-width: 767px)").matches) {
                logContentRef.current?.focus();
                return;
              }
              document.getElementById(logDateId)?.focus();
            }}
            onCloseAutoFocus={(e) => {
              // Radix returns focus only to a Dialog.Trigger inside this Root,
              // and the Log watch button lives in the Card below, so focus fell
              // to <body> on close (JK-03). Hand it back by hand.
              e.preventDefault();
              logTriggerRef.current?.focus();
            }}
            className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none data-[state=open]:animate-[dialog-content-in_0.2s_cubic-bezier(0.16,1,0.3,1)]"
          >
            <Dialog.Close
              className="absolute right-3 top-3 -m-3 flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-brand/60 sm:m-0 sm:min-h-0 sm:min-w-0"
              aria-label="Close"
            >
              <X size={18} />
            </Dialog.Close>
            <Dialog.Title className="text-sm font-semibold">Log a watch</Dialog.Title>
            <Dialog.Description className="mt-1.5 text-sm text-muted">
              Record a viewing. Logging again on a watched title counts as a
              rewatch.
            </Dialog.Description>
            <form
              method="post"
              className="mt-4 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (isLogging) return;
                submitLog();
              }}
            >
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={logDateId}
                  className="text-xs font-medium text-muted"
                >
                  Date watched
                </label>
                <input
                  id={logDateId}
                  type="date"
                  value={logDate}
                  onChange={(e) => setLogDate(e.target.value)}
                  className="h-11 w-full rounded-lg bg-surface-2 px-3 text-base text-foreground ring-1 ring-line-strong focus:outline-hidden focus:ring-2 focus:ring-brand/60 forced-colors:border sm:h-10 sm:text-sm [color-scheme:dark]"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={logNoteId}
                  className="text-xs font-medium text-muted"
                >
                  Note (optional)
                </label>
                <Input
                  id={logNoteId}
                  value={logNote}
                  onChange={(e) => setLogNote(e.target.value)}
                  placeholder="Watched with..."
                  maxLength={500}
                />
              </div>
              <div className="mt-1 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  disabled={isLogging || !logDate}
                >
                  {isLogging ? "Logging…" : "Log watch"}
                </Button>
              </div>
            </form>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      <Card className="flex flex-col gap-5 p-5">
      <Field label="Status" htmlFor={statusId}>
        <Select
          id={statusId}
          value={localStatus}
          onChange={(e) => {
            const v = e.target.value as WatchStatus;
            setLocalStatus(v);
            if (statusNavigationRef.current) {
              statusNavigationRef.current = false;
              statusStagedRef.current = true;
              return;
            }
            statusStagedRef.current = false;
            latestImmediateRef.current.status = v;
            commitImmediate();
          }}
          onBlur={(e) => {
            statusNavigationRef.current = false;
            statusStagedRef.current = false;
            latestImmediateRef.current.status = e.currentTarget.value as WatchStatus;
            commitImmediate();
          }}
          onKeyDown={(e) => {
            if (STATUS_NAVIGATION_KEYS.has(e.key)) {
              statusNavigationRef.current = true;
              return;
            }
            if (e.key === "Enter") {
              statusNavigationRef.current = false;
              statusStagedRef.current = false;
              latestImmediateRef.current.status = e.currentTarget.value as WatchStatus;
              commitImmediate();
            }
          }}
          onKeyUp={(e) => {
            // At a list boundary an arrow key may not emit change; do not let its
            // marker leak into a later pointer selection.
            if (STATUS_NAVIGATION_KEYS.has(e.key)) statusNavigationRef.current = false;
          }}
          className="w-full"
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {STATUS_META[s].label}
            </option>
          ))}
        </Select>
      </Field>

      <Button
        variant="secondary"
        size="sm"
        onClick={openLog}
        className="w-full sm:w-auto sm:self-start"
      >
        Log watch
      </Button>

      <Field label="Your rating">
        <RatingStars
          value={localRating}
          onChange={(v) => {
            setLocalRating(v);
            latestImmediateRef.current.rating = v;
            commitImmediate();
          }}
        />
      </Field>

      <Field label="Date watched">
        <input
          type="date"
          value={localWatchedAt}
          aria-label="Date watched"
          onChange={(e) => {
            const v = e.target.value;
            setLocalWatchedAt(v);
            latestImmediateRef.current.watchedAt = v;
            commitImmediate();
          }}
          className="h-11 w-full rounded-lg bg-surface-2 px-3 text-base text-foreground ring-1 ring-line-strong focus:outline-hidden focus:ring-2 focus:ring-brand/60 forced-colors:border sm:h-10 sm:text-sm [color-scheme:dark]"
        />
      </Field>

      <Field label="Notes" htmlFor={notesId}>
        <Textarea
          id={notesId}
          value={localNotes}
          onChange={(e) => {
            const v = e.target.value;
            setLocalNotes(v);
            latestNotesRef.current = v;
            // Editing clears a stale "Saved"/error; a running save keeps its
            // state (the drain loop will pick up this newer text).
            setNotesStatus((s) => (s === "saving" ? s : "idle"));
            scheduleSave();
          }}
          onBlur={flushNotes}
          placeholder="Private notes. Recommendations can use them as context."
          rows={4}
          maxLength={2000}
        />
        <div className="mt-2 flex min-h-4 items-start justify-between gap-3">
          {notesStatus === "error" ? (
            <p role="alert" className="flex items-center gap-2 text-xs text-rose-300">
              Couldn&apos;t save notes.
              <button
                type="button"
                onClick={flushNotes}
                className="focus-ring inline-flex min-h-11 items-center rounded px-1 font-medium text-rose-200 underline underline-offset-2 hover:text-rose-100 sm:min-h-0"
              >
                Retry
              </button>
            </p>
          ) : (
            <p
              role="status"
              className={cn(
                "text-xs",
                notesStatus === "saved" ? "text-emerald-400/90" : "text-faint",
              )}
            >
              {notesStatus === "saving"
                ? "Saving…"
                : notesStatus === "saved"
                  ? "Saved"
                  : notesDirty
                    ? "Unsaved changes"
                    : ""}
            </p>
          )}
          {localNotes.length > 1800 && (
            <p className="shrink-0 text-right text-xs text-faint">
              {localNotes.length}/2000
            </p>
          )}
        </div>
      </Field>

      <div className="flex items-center gap-2 border-t border-line pt-4">
        <Button
          variant={localFav ? "primary" : "secondary"}
          size="sm"
          aria-pressed={localFav}
          onClick={() => {
            const v = !localFav;
            setLocalFav(v);
            latestImmediateRef.current.favorite = v;
            commitImmediate();
          }}
        >
          <Heart size={15} className={cn(localFav && "fill-current")} />
          {localFav ? "Favorited" : "Favorite"}
        </Button>
        <Button
          variant="danger"
          size="sm"
          className="ml-auto"
          onClick={async () => {
            if (
              !(await confirm({
                title: "Move to Trash?",
                body: "This moves it to Trash. You can restore it from there.",
                confirmLabel: "Move to Trash",
                destructive: true,
              }))
            )
              return;
            startTransition(async () => {
              try {
                const res = await removeTitle(id);
                if (res.error) {
                  toast.error(res.error);
                  return;
                }
                undoToast("Moved to Trash", {
                  undo: () => restoreTitle(id),
                  success: "Restored to your library",
                  failure: "Couldn't undo that. Restore the title from Trash.",
                  onSuccess: () => {
                    router.push(`/title/${id}`);
                    router.refresh();
                  },
                });
                router.push("/");
                router.refresh();
              } catch {
                toast.error("Couldn't move this title to Trash. Please try again.");
              }
            });
          }}
        >
          <Trash2 size={15} />
          Remove
        </Button>
      </div>
      </Card>
    </>
  );
}

/**
 * A stored instant as the yyyy-mm-dd a date input holds, read in the account's
 * zone. Slicing the ISO string read it as UTC, so a viewing entered west of UTC
 * came back showing the day before the one the server had filed it under
 * (AUD-05). Falls back to UTC on a zone Intl rejects, as dayKeyInZone does
 * server-side. Exported for the History list next door, which edits the same
 * dates and must agree with this field to the day.
 */
export function dayInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  };
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
  } catch {
    fmt = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  const parts = fmt.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Today as yyyy-mm-dd in the viewer's local time — the log-watch date default. */
function todayLocalDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const fieldLabelClass = "text-xs font-medium uppercase tracking-wide text-faint";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  /** Id of the control this field wraps. Pass it whenever the field holds a
   *  single native control: naming the group does not name the control inside
   *  it, so without this the control reaches assistive tech unlabelled. */
  htmlFor?: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div role="group" aria-labelledby={labelId} className="flex flex-col gap-2">
      {htmlFor ? (
        <label id={labelId} htmlFor={htmlFor} className={fieldLabelClass}>
          {label}
        </label>
      ) : (
        <span id={labelId} className={fieldLabelClass}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
