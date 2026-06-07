"use client";

import { type RefObject, useState, useTransition } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Copy, ExternalLink, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { Button, Input } from "@/components/ui";
import { createShareList } from "@/lib/share-actions";
import { cn } from "@/lib/utils";

export function ShareDialog({
  open,
  onClose,
  titleIds,
  count,
  opener,
}: {
  open: boolean;
  onClose: () => void;
  /** Empty/undefined = whole library. */
  titleIds?: string[];
  /** Count shown in the prompt; if 0/undefined, treated as whole-library. */
  count?: number;
  /** Element to restore focus to on close (the control that opened the dialog). */
  opener?: RefObject<HTMLElement | null>;
}) {
  const wholeLibrary = !titleIds || titleIds.length === 0;
  const [name, setName] = useState("");
  const [includeNotes, setIncludeNotes] = useState(false);
  const [includeWatchlist, setIncludeWatchlist] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function reset() {
    setName("");
    setIncludeNotes(false);
    setIncludeWatchlist(false);
    setUrl(null);
    setCopied(false);
    setError(null);
  }

  // Radix unmounts the content on close, so resetting here can't clobber a reopen.
  function handleOpenChange(next: boolean) {
    if (!next) {
      onClose();
      reset();
    }
  }

  function create() {
    setError(null);
    start(async () => {
      const res = await createShareList({
        titleIds: wholeLibrary ? [] : titleIds,
        name: name || null,
        includeNotes,
        includeWatchlist: wholeLibrary ? includeWatchlist : false,
      });
      if (res.error || !res.slug) {
        setError(res.error ?? "Could not create link.");
        return;
      }
      setUrl(`${window.location.origin}/s/${res.slug}`);
      toast.success("Share link created");
    });
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy that. Select the link and copy it manually.");
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-[dialog-overlay-in_0.2s_ease-out]" />
        <Dialog.Content
          onCloseAutoFocus={(e) => {
            if (opener?.current) {
              e.preventDefault();
              opener.current.focus();
            }
          }}
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none data-[state=open]:animate-[dialog-content-in_0.2s_cubic-bezier(0.16,1,0.3,1)]"
        >
          <Dialog.Close
            className="absolute right-3 top-3 text-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 rounded"
            aria-label="Close"
          >
            <X size={18} />
          </Dialog.Close>

          <div className="mb-4 flex items-center gap-2.5">
            <span className="text-brand">
              <Link2 size={18} />
            </span>
            <Dialog.Title className="text-sm font-semibold">
              {wholeLibrary
                ? "Share your whole library"
                : `Share ${count ?? titleIds!.length} selected`}
            </Dialog.Title>
          </div>

          {!url ? (
            <div className="flex flex-col gap-3">
              <Dialog.Description className="text-xs text-muted">
                Anyone with the link can view a read-only page, no account
                needed. The link is unguessable, and you can revoke it anytime
                in Settings.
              </Dialog.Description>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted">
                  Title (optional)
                </span>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. My horror favourites"
                  maxLength={80}
                />
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                <input
                  type="checkbox"
                  checked={includeNotes}
                  onChange={(e) => setIncludeNotes(e.target.checked)}
                  className="h-4 w-4 accent-brand"
                />
                Include my personal notes
              </label>
              {wholeLibrary && (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted">
                  <input
                    type="checkbox"
                    checked={includeWatchlist}
                    onChange={(e) => setIncludeWatchlist(e.target.checked)}
                    className="h-4 w-4 accent-brand"
                  />
                  Include my watchlist (titles I haven&apos;t watched yet)
                </label>
              )}
              {error && (
                <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
                  {error}
                </p>
              )}
              <div className="mt-1 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={pending}
                  onClick={create}
                >
                  {pending ? "Creating…" : "Create link"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Dialog.Description className="text-xs text-emerald-300">
                ✓ Link ready. Share it with anyone.
              </Dialog.Description>
              <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 ring-1 ring-line">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90">
                  {url}
                </span>
                <button
                  onClick={copy}
                  className={cn(
                    "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
                    copied
                      ? "text-emerald-300"
                      : "text-muted hover:text-foreground",
                  )}
                >
                  {copied ? <Check size={13} /> : <Copy size={13} />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex justify-end gap-2">
                <a
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm text-muted hover:text-foreground"
                >
                  <ExternalLink size={14} /> Open
                </a>
                <Dialog.Close asChild>
                  <Button variant="primary" size="sm">
                    Done
                  </Button>
                </Dialog.Close>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
