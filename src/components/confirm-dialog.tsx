"use client";

import { useCallback, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { Button } from "@/components/ui";

interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
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
  const [opts, setOpts] = useState<ConfirmOptions>({ title: "" });
  const resolver = useRef<(v: boolean) => void>(() => {});

  const confirm = useCallback((o: ConfirmOptions) => {
    setOpts(o);
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

  const dialog = (
    <AlertDialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) settle(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-[dialog-overlay-in_0.2s_ease-out]" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none data-[state=open]:animate-[dialog-content-in_0.2s_cubic-bezier(0.16,1,0.3,1)]">
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
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                variant={opts.destructive ? "danger" : "primary"}
                size="sm"
                onClick={() => settle(true)}
              >
                {opts.confirmLabel ?? "Confirm"}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );

  return { confirm, dialog };
}
