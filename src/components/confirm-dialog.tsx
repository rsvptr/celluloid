"use client";

import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { whenIdle } from "@/lib/when-idle";
import { lazyDialog } from "./lazy-dialog";

type ConfirmViewProps = ComponentProps<typeof import("./confirm-dialog-view").ConfirmDialogView>;

/**
 * Stands in when the dialog's chunk won't load (P7U-1): the browser's own
 * confirm asks the same question, so every awaiting caller still settles.
 */
function NativeConfirm({ open, opts, onSettle }: ConfirmViewProps) {
  useEffect(() => {
    if (open) onSettle(window.confirm(opts.body ? `${opts.title}\n\n${opts.body}` : opts.title));
  }, [open, opts, onSettle]);
  return null;
}

// The AlertDialog markup, and Radix with it, loads after the page (VE-11).
// lazyDialog gives it its own Suspense boundary, so loading never suspends the
// component that renders {dialog}, and a failed load falls back to NativeConfirm.
const ConfirmDialogView = lazyDialog(
  () => import("./confirm-dialog-view").then((m) => m.ConfirmDialogView),
  NativeConfirm,
);

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  /** Names what staying put means when "Cancel" would be ambiguous. */
  cancelLabel?: string;
  destructive?: boolean;
}

/**
 * Themed replacement for window.confirm. Usage:
 *   const { confirm, dialog } = useConfirm();
 *   ...if (!(await confirm({ title, body, destructive: true })) return;
 *   ...render {dialog} once in the component tree.
 */
export function useConfirm() {
  const [open, setOpen] = useState(false);
  // The dialog mounts once the page is idle, or on the first confirm if that
  // comes sooner, and then stays mounted so it can animate out (EM-03).
  // Mounting ahead of the click matters: a lazy component that first suspends
  // on the click shows up no sooner than 300 ms later (React throttles
  // Suspense reveals), even with its chunk already cached.
  const [mounted, setMounted] = useState(false);
  useEffect(() => whenIdle(() => setMounted(true)), []);
  const [opts, setOpts] = useState<ConfirmOptions>({ title: "" });
  const resolver = useRef<(v: boolean) => void>(() => {});
  // Radix returns focus only to a Dialog.Trigger, and this dialog opens
  // imperatively without one, so focus used to fall to <body> on close (JK-03).
  // Remember whatever opened it and hand focus back in onCloseAutoFocus.
  const opener = useRef<HTMLElement | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    // A second confirm before the first is answered (a double click while the
    // chunk loads) cancels the first rather than sharing its answer: a stale
    // request never gets a "yes" it didn't show, and its caller still settles
    // and clears any busy state (P7U-3).
    resolver.current(false);
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setOpts(o);
    setMounted(true);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((v: boolean) => {
    setOpen(false);
    const r = resolver.current;
    resolver.current = () => {};
    r(v);
  }, []);

  const dialog = mounted ? (
    <ConfirmDialogView
      open={open}
      opts={opts}
      onSettle={settle}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        const el = opener.current;
        opener.current = null;
        // Confirming a delete can remove the opener with its row; land on
        // the (app) layout's <main tabIndex={-1}> rather than <body>.
        if (el?.isConnected) el.focus();
        else document.getElementById("main")?.focus();
      }}
    />
  ) : null;

  return { confirm, dialog };
}
