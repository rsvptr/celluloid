"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Copy, Link2 } from "lucide-react";
import type { ShareSummary } from "@/lib/data";
import { Button, Card, Input, Select, softDisabledClass } from "@/components/ui";
import { useConfirm } from "@/components/confirm-dialog";
import { fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  deleteShareList,
  getShareListTitles,
  renameShareList,
  restoreShareList,
  revokeShareList,
  setShareExpiry,
  type SharedTitleSummary,
} from "@/lib/share-actions";
import { Notice, Section, copyText } from "./settings-ui";

export function SharedLinksSection({ shares }: { shares: ShareSummary[] }) {
  const { confirm, dialog } = useConfirm();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  function copy(slug: string) {
    copyText(`${window.location.origin}/s/${slug}`, "Link copied");
  }

  async function revoke(id: string) {
    if (
      !(await confirm({
        title: "Revoke this link?",
        body: "Anyone holding the link will lose access immediately.",
        confirmLabel: "Revoke",
        destructive: true,
      }))
    )
      return;
    setPendingAction(`revoke:${id}`);
    try {
      const result = await revokeShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link revoked");
    } catch {
      toast.error("Couldn't revoke that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function restore(id: string) {
    setPendingAction(`restore:${id}`);
    try {
      const result = await restoreShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link restored. The same URL works again.");
    } catch {
      toast.error("Couldn't restore that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  async function remove(id: string, active: boolean) {
    if (
      !(await confirm({
        title: "Delete this shared link?",
        body: active
          ? "The link will stop working immediately and its record will be permanently removed."
          : "This permanently removes the link record from Settings.",
        confirmLabel: "Delete link",
        destructive: true,
      }))
    )
      return;
    setPendingAction(`delete:${id}`);
    try {
      const result = await deleteShareList(id);
      if (!result.ok) throw new Error();
      toast.success("Link deleted");
      // The row, and the Delete button that had focus, are gone.
      document.getElementById("settings-shared-links-heading")?.focus();
    } catch {
      toast.error("Couldn't delete that link. Please try again.");
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <>
      {dialog}
      <Section
        icon={Link2}
        title="Shared links"
        headingId="settings-shared-links-heading"
        description="Read-only links to your library. Revoke access without losing the record, or delete it permanently."
      >
        {shares.length === 0 ? (
          <p className="text-sm text-muted">
            No links yet. Use “Share” on the Library page to make one.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shares.map((s) => (
              <ShareRow
                key={s.id}
                share={s}
                busy={pendingAction !== null}
                pendingAction={pendingAction}
                onCopy={() => copy(s.slug)}
                onRevoke={() => revoke(s.id)}
                onRestore={() => restore(s.id)}
                onDelete={() => remove(s.id, s.state === "ACTIVE")}
              />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

const EXPIRY_CHOICES: { value: string; label: string }[] = [
  { value: "never", label: "Never expires" },
  { value: "7", label: "7 days from now" },
  { value: "30", label: "30 days from now" },
  { value: "90", label: "90 days from now" },
];

function ShareRow({
  share: s,
  busy,
  pendingAction,
  onCopy,
  onRevoke,
  onRestore,
  onDelete,
}: {
  share: ShareSummary;
  busy: boolean;
  pendingAction: string | null;
  onCopy: () => void;
  onRevoke: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [manageOpen, setManageOpen] = useState(false);
  const [name, setName] = useState(s.name ?? "");
  const [titles, setTitles] = useState<SharedTitleSummary[] | null>(null);
  const [titlesError, setTitlesError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  // Take the server's name whenever it changes (the rename above, or another
  // tab), adjusted during render rather than by re-keying the row: a new key
  // would remount and slam the manage panel shut on every save. Same "adjusting
  // state when a prop changes" pattern the library's Trash count uses.
  const [syncedName, setSyncedName] = useState(s.name ?? "");
  if ((s.name ?? "") !== syncedName) {
    setSyncedName(s.name ?? "");
    setName(s.name ?? "");
  }

  const active = s.state === "ACTIVE";
  const stateLabel =
    s.state === "ACTIVE" ? "Live" : s.state === "EXPIRED" ? "Expired" : "Revoked";
  const expiry = s.expiresAt ? fullDate(s.expiresAt) : "Never expires";

  // The published set is only fetched when the owner actually opens the panel:
  // a whole-library share resolves the entire library, which is far too much
  // work to do for every row on every visit to Settings.
  useEffect(() => {
    if (!manageOpen || titles !== null) return;
    let cancelled = false;
    getShareListTitles(s.id)
      .then((res) => {
        if (cancelled) return;
        if (res.error || !res.titles) {
          setTitlesError(res.error ?? "Couldn't load what this link publishes.");
          return;
        }
        setTitlesError(null);
        setTitles(res.titles);
      })
      .catch(() => {
        if (!cancelled) setTitlesError("Couldn't load what this link publishes.");
      });
    return () => {
      cancelled = true;
    };
  }, [manageOpen, titles, s.id]);

  function saveName() {
    startSaving(async () => {
      try {
        const result = await renameShareList(s.id, name);
        if (!result.ok) throw new Error();
        toast.success("Link renamed");
      } catch {
        toast.error("Couldn't rename that link. Please try again.");
      }
    });
  }

  function changeExpiry(value: string) {
    startSaving(async () => {
      try {
        const result = await setShareExpiry(
          s.id,
          value === "never" ? null : (Number(value) as 7 | 30 | 90),
        );
        if (!result.ok) throw new Error();
        toast.success(value === "never" ? "Expiry removed" : "Expiry updated");
      } catch {
        toast.error("Couldn't change the expiry. Please try again.");
      }
    });
  }

  const panelId = `share-manage-${s.id}`;

  return (
    <li className="flex flex-col gap-2.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className="truncate text-sm font-medium" title={s.name ?? undefined}>
              {s.name ?? "Untitled list"}
            </p>
            <span
              className={
                active
                  ? "shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300 ring-1 ring-emerald-500/20"
                  : "shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-muted ring-1 ring-line"
              }
            >
              {stateLabel}
            </span>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted">
            /s/{s.slug} · {s.count === null ? "Whole library" : `${s.count} titles`}
            {s.includeNotes ? " · notes shown" : ""}
          </p>
          <p className="mt-0.5 text-xs text-faint">
            {s.expiresAt ? `Expires ${expiry}` : expiry}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          <button
            type="button"
            onClick={onCopy}
            title={active ? "Copy link" : `${stateLabel} links cannot be opened`}
            aria-label={`Copy ${s.name ?? "untitled"} share link`}
            disabled={!active || busy}
            className="focus-ring flex min-h-11 min-w-11 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35 sm:h-8 sm:min-h-0 sm:w-8 sm:min-w-0"
          >
            <Copy aria-hidden="true" size={16} />
          </button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={manageOpen}
            aria-controls={panelId}
            onClick={() => {
              // Opening starts a new load when the last one failed, so its
              // error gives way to "Loading…".
              if (!manageOpen) setTitlesError(null);
              setManageOpen((v) => !v);
            }}
          >
            <ChevronDown
              aria-hidden="true"
              size={16}
              className={cn("transition-transform", manageOpen && "rotate-180")}
            />
            Manage
          </Button>
          {s.state === "REVOKED" ? (
            <Button variant="ghost" size="sm" disabled={busy} onClick={onRestore}>
              {pendingAction === `restore:${s.id}` ? "Restoring…" : "Un-revoke"}
            </Button>
          ) : active ? (
            <Button
              variant="ghost"
              size="sm"
              aria-disabled={busy}
              className={softDisabledClass}
              onClick={() => {
                if (busy) return;
                onRevoke();
              }}
            >
              {pendingAction === `revoke:${s.id}` ? "Revoking…" : "Revoke"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className={cn("text-rose-300 hover:text-rose-200", softDisabledClass)}
            aria-disabled={busy}
            onClick={() => {
              if (busy) return;
              onDelete();
            }}
          >
            {pendingAction === `delete:${s.id}` ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>

      {manageOpen && (
        <div id={panelId}>
          <Card variant="inset" className="flex flex-col gap-3 p-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Link name</span>
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  maxLength={80}
                  placeholder="Untitled list"
                  onChange={(e) => setName(e.target.value)}
                  className="min-w-0 flex-1"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={saving || busy || name.trim() === (s.name ?? "")}
                  onClick={saveName}
                >
                  Save
                </Button>
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">Expiry</span>
              <Select
                value=""
                className="w-full"
                disabled={saving || busy}
                onChange={(e) => {
                  if (e.target.value) changeExpiry(e.target.value);
                }}
              >
                <option value="">Change expiry…</option>
                {EXPIRY_CHOICES.map((choice) => (
                  <option key={choice.value} value={choice.value}>
                    {choice.label}
                  </option>
                ))}
              </Select>
              <span className="text-xs text-faint">
                Counted from now, so this also brings an expired link back.
              </span>
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-muted">
                {s.scope === "WHOLE_LIBRARY"
                  ? "Titles this link publishes right now"
                  : "Titles this link publishes"}
              </span>
              {titlesError ? (
                <Notice kind="error">{titlesError}</Notice>
              ) : titles === null ? (
                <p className="text-xs text-muted">Loading…</p>
              ) : titles.length === 0 ? (
                <p className="text-xs text-muted">
                  Nothing. Every title this link referenced has since been removed.
                </p>
              ) : (
                <>
                  <p className="text-xs text-faint">
                    {titles.length} {titles.length === 1 ? "title" : "titles"}
                    {s.includeNotes ? ", with your notes attached" : ""}.
                  </p>
                  <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-lg bg-surface ring-1 ring-line">
                    {titles.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 text-xs"
                      >
                        <span className="min-w-0 flex-1 truncate text-foreground/90" title={t.name}>
                          {t.name}
                        </span>
                        <span className="shrink-0 text-faint">
                          {t.mediaType === "TV" ? "TV" : "Movie"}
                          {t.year ? ` · ${t.year}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Card>
        </div>
      )}
    </li>
  );
}
