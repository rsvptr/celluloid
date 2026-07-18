"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, CircleAlert, Replace, RotateCcw, Square, X } from "lucide-react";
import { toast } from "sonner";
import type { SearchResult } from "@/app/api/search/route";
import { useConfirm } from "@/components/confirm-dialog";
import { Poster } from "@/components/poster";
import { TmdbSearch } from "@/components/tmdb-search";
import { Button, Card, Spinner } from "@/components/ui";
import {
  IMPORT_COMMIT_BATCH_SIZE,
  IMPORT_MAX_ATTEMPTS,
  isTerminalImportItem,
  type ProposedImportMatch,
  type StagedImportItemView,
  type StagedImportJobView,
} from "@/lib/import-staging-format";
import { cn } from "@/lib/utils";

function confidence(score: number | null): string {
  if (score === null) return "Needs match";
  if (score >= 0.9) return "High confidence";
  if (score >= 0.7) return "Good confidence";
  return "Check match";
}

function yearOf(item: StagedImportItemView): string {
  return item.parsed.releaseDate?.slice(0, 4) ?? "Year unknown";
}

function proposedFromSearch(result: SearchResult): ProposedImportMatch {
  return {
    tmdbId: result.tmdbId,
    mediaType: result.mediaType,
    name: result.name,
    year: result.year,
    posterPath: result.posterPath,
  };
}

export function ImportReview({
  initialJob,
  onStartAnother,
}: {
  initialJob: StagedImportJobView;
  onStartAnother: () => void;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [job, setJob] = useState(initialJob);
  const [busyItem, setBusyItem] = useState<string | null>(null);
  const [matchingItem, setMatchingItem] = useState<StagedImportItemView | null>(null);
  const [committing, setCommitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matchOpener = useRef<HTMLElement | null>(null);

  const terminalCount = useMemo(
    () => job.items.filter((item) => isTerminalImportItem(item)).length,
    [job.items],
  );
  const actionableCount = job.items.filter(
    (item) =>
      !item.titleId &&
      (item.action === "CREATE" ||
        item.action === "UPDATE" ||
        (item.action === "FAILED" && item.attempts < IMPORT_MAX_ATTEMPTS)),
  ).length;
  const complete = job.status === "COMPLETED" || job.status === "PARTIAL";
  const canCommit = actionableCount > 0 || terminalCount === job.items.length;
  const percent = job.items.length === 0 ? 0 : Math.round((terminalCount / job.items.length) * 100);

  async function updateItem(
    itemId: string,
    body: { exclude: boolean } | { proposed: ProposedImportMatch } | { retry: true },
  ) {
    setBusyItem(itemId);
    setError(null);
    try {
      const response = await fetch(`/api/import/jobs/${job.id}/items/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await response.json().catch(() => null)) as
        | { job?: StagedImportJobView; error?: string }
        | null;
      if (!response.ok || !data?.job) {
        throw new Error(data?.error ?? "Celluloid couldn't update that row. Try again.");
      }
      setJob(data.job);
      return true;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Celluloid couldn't update that row.");
      return false;
    } finally {
      setBusyItem(null);
    }
  }

  async function commit() {
    // A review containing only excluded/conflicting rows still needs one server
    // pass to durably settle the job as COMPLETED/PARTIAL.
    if (committing) return;
    setCommitting(true);
    setError(null);
    try {
      let current = job;
      const maxBatches =
        Math.ceil(
          (job.items.length * IMPORT_MAX_ATTEMPTS) / IMPORT_COMMIT_BATCH_SIZE,
        ) + 1;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const response = await fetch(`/api/import/jobs/${job.id}/commit`, { method: "POST" });
        const data = (await response.json().catch(() => null)) as
          | { job?: StagedImportJobView; error?: string }
          | null;
        if (!response.ok || !data?.job) {
          throw new Error(data?.error ?? "Import paused. Your completed rows are safely saved.");
        }
        current = data.job;
        setJob(current);
        if (current.status !== "COMMITTING") break;
      }
      if (current.status === "COMMITTING") {
        throw new Error(
          "Import paused. Your completed rows are safely saved; press Commit to resume.",
        );
      }
      router.refresh();
      if (current.status === "COMPLETED") toast.success("Import completed");
      else if (current.status === "PARTIAL") toast.info("Import finished with rows to review");
    } catch (commitError) {
      setError(
        commitError instanceof Error
          ? commitError.message
          : "Import paused. Your completed rows are safely saved; press Commit to resume.",
      );
    } finally {
      setCommitting(false);
    }
  }

  async function cancel() {
    const approved = await confirm({
      title: "Cancel this import?",
      body: "Rows already committed stay in your library. Uncommitted rows will be abandoned.",
      confirmLabel: "Cancel import",
      destructive: true,
    });
    if (!approved) return;
    setCancelling(true);
    try {
      const response = await fetch(`/api/import/jobs/${job.id}/cancel`, { method: "POST" });
      if (!response.ok) throw new Error();
      onStartAnother();
      toast.success("Import cancelled");
    } catch {
      setError("Celluloid couldn't cancel that import. Try again.");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      {dialog}
      <Card className="flex flex-col gap-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Import review</p>
            <h2 className="mt-1 text-base font-semibold">{job.filename}</h2>
            <p className="mt-1 text-xs text-muted">
              Confirm each TMDB match, exclude rows you do not want, then commit in safe resumable batches.
            </p>
          </div>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted ring-1 ring-line">
            {job.items.length} {job.items.length === 1 ? "row" : "rows"}
          </span>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span>{committing ? "Saving import…" : complete ? "Import pass finished" : "Ready for review"}</span>
            <span className="tabular-nums">{terminalCount}/{job.items.length}</span>
          </div>
          <div
            role="progressbar"
            aria-label="Import progress"
            aria-valuemin={0}
            aria-valuemax={job.items.length}
            aria-valuenow={terminalCount}
            className="h-1.5 overflow-hidden rounded-full bg-surface-2 ring-1 ring-line"
          >
            <div className="h-full rounded-full brand-gradient transition-[width]" style={{ width: `${percent}%` }} />
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
            {error}
          </p>
        ) : null}

        <ul className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto overscroll-contain pr-1" aria-label="Import rows">
          {job.items.map((item) => {
            const excluded = item.action === "SKIP";
            const done = item.titleId !== null;
            const failed = item.action === "FAILED";
            return (
              <li
                key={item.id}
                className={cn(
                  "rounded-xl bg-surface-2/35 p-3 ring-1 ring-line [content-visibility:auto] [contain-intrinsic-size:96px]",
                  excluded && "opacity-60",
                )}
              >
                <div className="flex items-start gap-3">
                  <label className="flex min-h-11 shrink-0 cursor-pointer items-center" title={done ? "Already committed" : undefined}>
                    <input
                      type="checkbox"
                      checked={!excluded}
                      disabled={done || committing || busyItem === item.id}
                      aria-label={`Include ${item.parsed.name}`}
                      onChange={(event) => void updateItem(item.id, { exclude: !event.target.checked })}
                      className="h-4 w-4 accent-brand"
                    />
                  </label>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <p className="font-medium">{item.parsed.name}</p>
                      <span className="text-xs text-faint">
                        Row {item.rowNumber} · {item.parsed.mediaType === "tv" ? "TV" : "Movie"} · {yearOf(item)}
                      </span>
                    </div>

                    {item.proposed ? (
                      <div className="mt-2 flex min-w-0 items-center gap-2.5">
                        <div className="w-9 shrink-0">
                          <Poster
                            path={item.proposed.posterPath}
                            name={item.proposed.name}
                            decorative
                            mediaType={item.proposed.mediaType === "tv" ? "TV" : "MOVIE"}
                            size="w154"
                            sizes="36px"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm text-foreground/90">
                            {item.proposed.name}{item.proposed.year ? ` · ${item.proposed.year}` : ""}
                          </p>
                          <p className="text-xs text-muted">
                            {done
                              ? item.action === "CREATE" ? "Added to library" : "Existing title refreshed"
                              : excluded
                                ? "Excluded"
                                : item.action === "UPDATE"
                                  ? "Already in your library"
                                  : confidence(item.matchScore)}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-200">
                        <CircleAlert size={13} aria-hidden="true" /> No confident match yet
                      </p>
                    )}

                    {item.warning && !excluded ? (
                      <p className="mt-2 text-xs text-amber-200">{item.warning}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    {done ? (
                      <span className="flex min-h-8 items-center gap-1 text-xs font-medium text-emerald-300">
                        <Check size={13} aria-hidden="true" /> Saved
                      </span>
                    ) : failed && item.attempts >= IMPORT_MAX_ATTEMPTS ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyItem === item.id || committing}
                        onClick={() => void updateItem(item.id, { retry: true })}
                      >
                        <RotateCcw size={13} aria-hidden="true" /> Retry
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyItem === item.id || committing || excluded}
                        onClick={(event) => {
                          matchOpener.current = event.currentTarget;
                          setMatchingItem(item);
                        }}
                      >
                        {busyItem === item.id ? <Spinner /> : <Replace size={13} aria-hidden="true" />}
                        {item.proposed ? "Change" : "Match"}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Button type="button" variant="ghost" size="sm" disabled={committing || cancelling || complete} onClick={cancel}>
            {cancelling ? <Spinner /> : <Square size={13} aria-hidden="true" />}
            Cancel import
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {complete ? (
              <Button type="button" variant="secondary" size="sm" onClick={onStartAnother}>
                Import another file
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={committing || !canCommit || complete}
              onClick={commit}
            >
              {committing ? <Spinner /> : <Check size={14} aria-hidden="true" />}
              {committing
                ? "Saving batches…"
                : actionableCount > 0
                  ? `Commit ${actionableCount} ${actionableCount === 1 ? "row" : "rows"}`
                  : "Finish review"}
            </Button>
          </div>
        </div>
      </Card>

      <Dialog.Root open={matchingItem !== null} onOpenChange={(open) => !open && setMatchingItem(null)}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content
            onCloseAutoFocus={(event) => {
              if (matchOpener.current) {
                event.preventDefault();
                matchOpener.current.focus();
              }
            }}
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-[var(--radius-card)] bg-surface p-5 ring-1 ring-line focus:outline-none"
          >
            <Dialog.Close className="absolute right-3 top-3 flex min-h-11 min-w-11 items-center justify-center rounded text-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Close match search">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
            <Dialog.Title className="pr-10 text-sm font-semibold">
              Match “{matchingItem?.parsed.name ?? "import row"}”
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-muted">
              Pick the exact movie or TV show. Nothing is written to your library until Commit.
            </Dialog.Description>
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <TmdbSearch
                key={matchingItem?.id}
                autoFocus
                initialQuery={matchingItem?.parsed.name ?? ""}
                onPick={(result) => {
                  if (!matchingItem) return;
                  void updateItem(matchingItem.id, { proposed: proposedFromSearch(result) }).then((ok) => {
                    if (ok) setMatchingItem(null);
                  });
                }}
                placeholder="Search the correct title…"
              />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
