"use client";

import { useEffect, useState, useTransition } from "react";
import { Film, RotateCcw, Tv } from "lucide-react";
import { toast } from "sonner";
import {
  listSuppressions,
  unsuppressSuggestion,
  type SuppressionEntry,
} from "@/lib/suppression-actions";
import { Card, Spinner } from "@/components/ui";

const REASON_LABEL: Record<SuppressionEntry["reason"], string> = {
  NOT_INTERESTED: "Not interested",
  SEEN_ELSEWHERE: "Already seen",
};

/**
 * Review and undo the durable "not interested" list. Suppression silently
 * removes titles from every future run, so it needs somewhere to be looked at —
 * without this the owner could bury a title and have no way to find out why it
 * stopped being suggested.
 *
 * The list loads only when the panel is opened, and reloads whenever
 * `refreshKey` changes, so dismissing a card while the panel is open keeps the
 * two in step.
 */
export function SuppressionsPanel({ refreshKey }: { refreshKey: number }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<SuppressionEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, start] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listSuppressions()
      .then((rows) => {
        if (!cancelled) {
          setEntries(rows);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            "Your hidden titles could not be loaded. Check your connection and retry.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey, retryKey]);

  function restore(entry: SuppressionEntry) {
    if (pendingId) return; // one restore at a time; a second would race the list
    setPendingId(entry.id);
    start(async () => {
      try {
        const res = await unsuppressSuggestion(entry.id);
        if (!res.ok) {
          toast.error("Couldn't restore that title. Refresh and try again.");
          return;
        }
        setEntries((current) =>
          (current ?? []).filter((item) => item.id !== entry.id),
        );
        toast.success(`${entry.name} can be suggested again`);
      } catch {
        toast.error(
          "Celluloid couldn't restore that title. Check your connection and retry.",
        );
      } finally {
        setPendingId(null);
      }
    });
  }

  return (
    <Card>
      <details
        onToggle={(event) => setOpen(event.currentTarget.open)}
        className="rounded-[var(--radius-card)]"
      >
        <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-card)] px-4 py-3 text-sm font-medium marker:text-faint">
          Not interested
          <span className="text-xs font-normal text-faint">
            Titles hidden from future suggestions
          </span>
        </summary>
        <div className="border-t border-line px-4 py-4">
          {loadError ? (
            <div
              role="alert"
              className="flex flex-col items-center gap-2 rounded-lg bg-rose-500/10 px-3 py-3 text-center text-xs text-rose-200 ring-1 ring-rose-500/20"
            >
              <p>{loadError}</p>
              <button
                type="button"
                onClick={() => {
                  setEntries(null);
                  setLoadError(null);
                  setRetryKey((value) => value + 1);
                }}
                className="focus-ring min-h-11 rounded-lg px-3 py-1.5 font-medium ring-1 ring-rose-500/30 hover:bg-rose-500/10 sm:min-h-0"
              >
                Retry
              </button>
            </div>
          ) : entries === null ? (
            <p className="py-2 text-center text-xs text-muted">Loading hidden titles…</p>
          ) : entries.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted">
              Nothing hidden yet. Dismissing a suggestion keeps it out of future runs.
            </p>
          ) : (
            <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto overscroll-contain">
              {entries.map((entry) => {
                const Icon = entry.mediaType === "tv" ? Tv : Film;
                return (
                  <li
                    key={entry.id}
                    className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                  >
                    <Icon size={14} aria-hidden="true" className="shrink-0 text-muted" />
                    <span className="min-w-0 flex-1 truncate">
                      {entry.name}
                      {entry.year ? (
                        <span className="text-faint"> · {entry.year}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-xs text-faint">
                      {REASON_LABEL[entry.reason]}
                    </span>
                    <button
                      type="button"
                      disabled={pendingId === entry.id}
                      onClick={() => restore(entry)}
                      aria-label={`Allow ${entry.name} to be suggested again`}
                      className="focus-ring flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:opacity-50 sm:min-h-0"
                    >
                      {pendingId === entry.id ? (
                        <Spinner />
                      ) : (
                        <RotateCcw size={13} aria-hidden="true" />
                      )}
                      Restore
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
    </Card>
  );
}
