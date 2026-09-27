"use client";

import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Button } from "@/components/ui";
import type { ConfirmOptions } from "./confirm-dialog";

/** useConfirm's dialog, in its own module so Radix loads after the page (VE-11). */
export function ConfirmDialogView({
  open,
  opts,
  onSettle,
  onCloseAutoFocus,
}: {
  open: boolean;
  opts: ConfirmOptions;
  onSettle: (confirmed: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}) {
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onSettle(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="dialog-overlay fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <AlertDialog.Content
          onCloseAutoFocus={onCloseAutoFocus}
          className="dialog-content fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none"
        >
          <AlertDialog.Title className="text-sm font-semibold">
            {opts.title}
          </AlertDialog.Title>
          {opts.body && (
            <AlertDialog.Description className="mt-1.5 text-sm text-muted">
              {opts.body}
            </AlertDialog.Description>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" size="sm">
                {opts.cancelLabel ?? "Cancel"}
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={opts.destructive ? "danger" : "primary"}
                size="sm"
                onClick={() => onSettle(true)}
              >
                {opts.confirmLabel ?? "Confirm"}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
