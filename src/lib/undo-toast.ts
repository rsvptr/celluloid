import { toast } from "sonner";

// JK-07: Sonner's 4 s default is gone before a keyboard user can reach Undo
// (it pauses on hover, not on focus; Alt+T focuses the toasts and pauses them),
// so undo toasts stay 10 s and carry a close button to dismiss them sooner.
export const UNDO_TOAST_DURATION = 10_000;
// The confirmation or error that replaces it goes back to Sonner's default.
const OUTCOME_DURATION = 4000;

type UndoToastOptions = {
  /** Runs the undo. A returned `error` shows on the toast; a throw shows `failure`. */
  undo: () => Promise<{ error?: string }>;
  /** Confirmation copy. Leave it out when the UI itself shows the undo landed. */
  success?: string;
  /** Copy for a thrown undo (network, server crash). */
  failure: string;
  onSuccess?: () => void;
  /** Runs after an error result or a throw, e.g. to re-sync a partial write. */
  onError?: () => void;
};

/**
 * A success toast with an Undo action that updates in place (EM-06). Sonner
 * closes a toast on its action unless the click is default-prevented, which
 * left nothing on screen for the second or so the undo took. Instead the same
 * toast (same `id`, merged by Sonner) turns into a spinner, then into the
 * confirmation or the error.
 */
export function undoToast(message: string, options: UndoToastOptions) {
  const { undo, success, failure, onSuccess, onError } = options;
  // Sonner re-renders on its next tick, so a second press (a held Enter, a
  // double click) can still reach this handler; run the undo only once.
  let started = false;
  const id = toast.success(message, {
    duration: UNDO_TOAST_DURATION,
    closeButton: true,
    action: {
      label: "Undo",
      onClick: (event) => {
        event.preventDefault();
        if (started) return;
        started = true;
        // The update below removes this button. If it had focus, park focus on
        // the toast itself (Sonner makes it focusable) so it doesn't fall to
        // <body>; the text changes are still announced by Sonner's live region.
        if (document.activeElement === event.currentTarget) {
          event.currentTarget
            .closest<HTMLElement>("[data-sonner-toast]")
            ?.focus({ preventScroll: true });
        }
        toast.loading("Undoing…", { id, action: undefined });
        void undo().then(
          (result) => {
            if (result.error) {
              toast.error(result.error, { id, duration: OUTCOME_DURATION });
              onError?.();
              return;
            }
            if (success) toast.success(success, { id, duration: OUTCOME_DURATION });
            else toast.dismiss(id);
            onSuccess?.();
          },
          () => {
            toast.error(failure, { id, duration: OUTCOME_DURATION });
            onError?.();
          },
        );
      },
    },
  });
  return id;
}
