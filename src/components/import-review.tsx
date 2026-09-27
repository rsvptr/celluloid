"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Check,
  CheckSquare,
  CircleAlert,
  Replace,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { SearchResult } from "@/app/api/search/route";
import { useConfirm } from "@/components/confirm-dialog";
import { Poster } from "@/components/poster";
import { TmdbSearch } from "@/components/tmdb-search";
import { Button, Card, Select, Spinner } from "@/components/ui";
import {
  IMPORT_COMMIT_BATCH_SIZE,
  IMPORT_MAX_ATTEMPTS,
  isTerminalImportItem,
  type ProposedImportMatch,
  type StagedImportItemView,
  type StagedImportJobView,
} from "@/lib/import-staging-views";
import { existingImportReviewFacts } from "@/lib/import-merge";
import { cn } from "@/lib/utils";

/** The one confidence scale in the review screen: the row label, the filter
 * buckets, and their counts are all read off it. */
type ConfidenceBucket = "needs" | "check" | "good" | "high";

const CONFIDENCE_LABELS: Record<ConfidenceBucket, string> = {
  needs: "Needs match",
  check: "Check match",
  good: "Good confidence",
  high: "High confidence",
};

// Chrome moves focus to <body> the instant a focused control becomes
// `disabled`. Cancel import opens a confirm and then goes busy, so it carries
// `aria-disabled` and returns early instead, keeping focus after confirming
// (JK-03). These classes reproduce Button's `disabled:` styling.
const softDisabledClass = "aria-disabled:cursor-not-allowed aria-disabled:opacity-50";

/** Least confident first, matching the default row order. */
const CONFIDENCE_ORDER: ConfidenceBucket[] = ["needs", "check", "good", "high"];

function bucketOf(score: number | null): ConfidenceBucket {
  if (score === null) return "needs";
  if (score >= 0.9) return "high";
  if (score >= 0.7) return "good";
  return "check";
}

function confidence(score: number | null): string {
  return CONFIDENCE_LABELS[bucketOf(score)];
}

function yearOf(item: StagedImportItemView): string {
  return item.parsed.releaseDate?.slice(0, 4) ?? "Year unknown";
}

/** What the sheet said about this title, beyond its name. */
function sheetFacts(item: StagedImportItemView): string[] {
  const status =
    item.parsed.status === "WATCHED"
      ? "Watched"
      : item.parsed.status === "PARTIALLY_WATCHED"
        ? "Partially watched"
        : "Watchlist";
  const facts: string[] = [`Sheet status: ${status}`];
  if (item.parsed.rating != null) facts.push(`Rated ${item.parsed.rating}`);
  if (item.parsed.watchedAt) facts.push(`Watched ${item.parsed.watchedAt}`);
  return facts;
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
  const [bucket, setBucket] = useState<ConfidenceBucket | "all">("all");
  const [order, setOrder] = useState<"confidence" | "file">("confidence");
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [excluding, setExcluding] = useState(false);
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
  const closed =
    job.status === "COMPLETED" || job.status === "PARTIAL" || job.status === "CANCELLED";
  // A job that is still PARSING has no rows yet. It is offered here so a second
  // tab can't be told the upload form is the right next step (which is how one
  // file becomes two jobs), but there is nothing to review and nothing to commit
  // until matching finishes.
  const parsing = job.status === "PARSING";
  // Inferences the parser had to make about the file's own conventions —
  // which column was a viewing date, whether a rating scale could be read.
  // Shown before any commit, because a wrong guess here writes real personal
  // data and the file cannot state its conventions itself.
  const parseNotes = useMemo(() => {
    const raw = job.summary?.notes;
    return Array.isArray(raw) ? raw.filter((n): n is string => typeof n === "string") : [];
  }, [job.summary]);
  // A PARSING job has no rows yet, and `terminalCount === job.items.length` is
  // trivially true at 0 === 0 — which left the commit button enabled on a job
  // with nothing in it. The server treats that commit as a no-op, but offering
  // it invites the owner to think the import finished with zero titles.
  const canCommit =
    !parsing && (actionableCount > 0 || terminalCount === job.items.length);
  const percent = job.items.length === 0 ? 0 : Math.round((terminalCount / job.items.length) * 100);

  const bucketCounts = useMemo(() => {
    const counts: Record<ConfidenceBucket, number> = { needs: 0, check: 0, good: 0, high: 0 };
    for (const item of job.items) counts[bucketOf(item.matchScore)] += 1;
    return counts;
  }, [job.items]);

  // Least-confident-first by default: on a 250-row import the rows that need a
  // decision are the only ones worth scrolling to, and they scored lowest.
  const visible = useMemo(() => {
    const rows = job.items.filter(
      (item) => bucket === "all" || bucketOf(item.matchScore) === bucket,
    );
    if (order === "file") return rows;
    return [...rows].sort(
      (a, b) => (a.matchScore ?? -1) - (b.matchScore ?? -1) || a.rowNumber - b.rowNumber,
    );
  }, [job.items, bucket, order]);

  // Only rows that are both visible and still editable can be acted on in bulk,
  // so a filtered-away or already-committed row can never be swept up by one.
  const selectableIds = useMemo(
    () => visible.filter((item) => !item.titleId).map((item) => item.id),
    [visible],
  );
  const selectedIds = useMemo(
    () => selectableIds.filter((id) => selected.has(id)),
    [selectableIds, selected],
  );

  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function toggleSelected(itemId: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  }

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

  async function excludeSelected() {
    if (selectedIds.length === 0 || excluding) return;
    setExcluding(true);
    setError(null);
    try {
      const response = await fetch(`/api/import/jobs/${job.id}/items`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exclude: true, itemIds: selectedIds }),
      });
      const data = (await response.json().catch(() => null)) as
        | { job?: StagedImportJobView; error?: string }
        | null;
      if (!response.ok || !data?.job) {
        throw new Error(data?.error ?? "Celluloid couldn't exclude those rows. Try again.");
      }
      setJob(data.job);
      toast.success(
        `${selectedIds.length} ${selectedIds.length === 1 ? "row" : "rows"} excluded`,
      );
      exitSelect();
    } catch (excludeError) {
      setError(
        excludeError instanceof Error
          ? excludeError.message
          : "Celluloid couldn't exclude those rows.",
      );
    } finally {
      setExcluding(false);
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
      // The server refuses to commit a job someone else closed, and says so by
      // returning its real state — surface that instead of a silent no-op.
      else if (current.status === "CANCELLED") {
        setError("This import was cancelled. Rows already saved stay in your library.");
      }
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
      // "Cancel" beside "Cancel import" read as the same action (JK-32).
      cancelLabel: "Keep importing",
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
            <p className="mt-1.5 max-w-2xl text-xs text-faint">
              New titles take the sheet&apos;s status, rating, and watch date. Existing titles
              refresh metadata, fill only a missing rating or watch date, and apply Watching
              or Watched only while the title is still on your Watchlist. Existing personal
              choices are never replaced.
            </p>
          </div>
          <span className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-medium text-muted ring-1 ring-line">
            {job.items.length} {job.items.length === 1 ? "row" : "rows"}
          </span>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
            <span>
              {committing
                ? "Saving import…"
                : parsing
                  ? `Still working on ${job.filename}…`
                  : job.status === "CANCELLED"
                    ? "Import cancelled"
                    : closed
                      ? "Import pass finished"
                      : "Ready for review"}
            </span>
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

        {parsing && (
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted ring-1 ring-line">
            Matching this file against TMDB. Leave this open, or come back to it
            later; the rows appear here when it finishes.
          </p>
        )}

        {parseNotes.length > 0 && (
          <div className="rounded-lg bg-amber-500/10 px-3 py-2.5 text-sm text-amber-200/90 ring-1 ring-amber-500/20">
            <p className="font-medium">What Celluloid assumed about this file</p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-amber-200/80">
              {parseNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-amber-200/70">
              If any of that is wrong, cancel and rename the columns in your
              spreadsheet rather than committing. Nothing has been saved yet.
            </p>
          </div>
        )}

        {error ? (
          <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
            {error}
          </p>
        ) : null}

        {job.items.length > 0 ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip
                active={bucket === "all"}
                onClick={() => setBucket("all")}
                label="All rows"
                count={job.items.length}
              />
              {CONFIDENCE_ORDER.map((id) => (
                <FilterChip
                  key={id}
                  active={bucket === id}
                  onClick={() => setBucket(id)}
                  label={CONFIDENCE_LABELS[id]}
                  count={bucketCounts[id]}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-xs text-muted">
                Order
                <Select
                  value={order}
                  onChange={(event) =>
                    setOrder(event.target.value === "file" ? "file" : "confidence")
                  }
                  aria-label="Row order"
                >
                  <option value="confidence">Least confident first</option>
                  <option value="file">File order</option>
                </Select>
              </label>
              <button
                type="button"
                onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
                // No aria-pressed: the label names the action and already
                // changes with the state (JK-06).
                disabled={committing || closed}
                className={cn(
                  "focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-8",
                  selectMode
                    ? "bg-brand/15 text-brand ring-brand/40"
                    : "text-muted ring-line hover:text-foreground",
                )}
              >
                <CheckSquare size={16} aria-hidden="true" />
                {selectMode ? "Done selecting" : "Select rows"}
              </button>
            </div>

            {selectMode ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2/50 px-3 py-2 ring-1 ring-line">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-muted tabular-nums">
                    {selectedIds.length} selected
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelected(
                        selectedIds.length === selectableIds.length
                          ? new Set()
                          : new Set(selectableIds),
                      )
                    }
                    disabled={selectableIds.length === 0}
                    className="focus-ring flex min-h-11 items-center rounded px-1 text-xs font-medium text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0"
                  >
                    {selectedIds.length === selectableIds.length && selectableIds.length > 0
                      ? "Clear selection"
                      : "Select all shown"}
                  </button>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={selectedIds.length === 0 || excluding}
                  onClick={excludeSelected}
                >
                  {excluding ? <Spinner /> : <Square size={13} aria-hidden="true" />}
                  Exclude {selectedIds.length > 0 ? selectedIds.length : ""}{" "}
                  {selectedIds.length === 1 ? "row" : "rows"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="rounded-lg bg-surface-2/50 px-3 py-2 text-sm text-muted ring-1 ring-line">
            This import has no rows to review. Cancel it and upload the file again.
          </p>
        )}

        <ul className="flex max-h-[36rem] flex-col gap-2 overflow-y-auto overscroll-contain pr-1" aria-label="Import rows">
          {visible.map((item) => {
            const excluded = item.action === "SKIP";
            const done = item.titleId !== null;
            const failed = item.action === "FAILED";
            const facts = sheetFacts(item);
            const mergeFacts = item.action === "UPDATE" ? existingImportReviewFacts(item.parsed) : [];
            return (
              <li
                key={item.id}
                className={cn(
                  "rounded-xl bg-surface-2/35 p-3 ring-1 ring-line [content-visibility:auto] [contain-intrinsic-size:96px]",
                  excluded && "opacity-60",
                  selectMode && selected.has(item.id) && "bg-brand/10",
                )}
              >
                <div className="flex items-start gap-3">
                  <label className="flex min-h-11 shrink-0 cursor-pointer items-center" title={done ? "Already committed" : undefined}>
                    <input
                      type="checkbox"
                      checked={selectMode ? selected.has(item.id) : !excluded}
                      disabled={done || committing || busyItem === item.id || excluding}
                      aria-label={
                        selectMode ? `Select ${item.parsed.name}` : `Include ${item.parsed.name}`
                      }
                      onChange={(event) =>
                        selectMode
                          ? toggleSelected(item.id)
                          : void updateItem(item.id, { exclude: !event.target.checked })
                      }
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

                    {facts.length > 0 ? (
                      <p className="mt-0.5 text-xs text-muted">{facts.join(" · ")}</p>
                    ) : null}

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
                              ? item.action === "CREATE" ? "Added to library" : "Existing title safely merged"
                              : excluded
                                ? "Excluded"
                                : item.action === "UPDATE"
                                  ? "Already in your library · safe merge on commit"
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

                    {mergeFacts.length > 0 && !excluded ? (
                      <p className="mt-2 text-xs text-faint">
                        Existing title: {mergeFacts.join(". ")}.
                      </p>
                    ) : null}

                    {item.parsed.ratingText && !excluded ? (
                      <p className="mt-2 text-xs text-amber-200">
                        Rating “{item.parsed.ratingText}” not imported: a column headed
                        “Rating” doesn’t say which scale it uses. Name it “Stars” for 0-5
                        or “Your Rating” for 0-10, or set the rating after the import.
                      </p>
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
                        disabled={busyItem === item.id || committing || selectMode}
                        onClick={() => void updateItem(item.id, { retry: true })}
                      >
                        <RotateCcw size={13} aria-hidden="true" /> Retry
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={busyItem === item.id || committing || excluded || selectMode}
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
          {job.items.length > 0 && visible.length === 0 ? (
            <li className="rounded-xl bg-surface-2/35 p-3 text-sm text-muted ring-1 ring-line">
              No rows in this confidence bucket.
            </li>
          ) : null}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={softDisabledClass}
            aria-disabled={committing || cancelling || closed}
            onClick={() => {
              if (committing || cancelling || closed) return;
              void cancel();
            }}
          >
            {cancelling ? <Spinner /> : <Square size={13} aria-hidden="true" />}
            Cancel import
          </Button>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {closed ? (
              <Button type="button" variant="secondary" size="sm" onClick={onStartAnother}>
                Import another file
              </Button>
            ) : null}
            <Button
              type="button"
              variant="primary"
              size="sm"
              disabled={committing || !canCommit || closed}
              onClick={commit}
            >
              {committing ? <Spinner /> : <Check size={16} aria-hidden="true" />}
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
              <X size={20} aria-hidden="true" />
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

function FilterChip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "focus-ring flex min-h-11 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors sm:min-h-0",
        active
          ? "bg-brand/15 text-brand ring-brand/40"
          : "bg-surface-2 text-muted ring-line hover:text-foreground",
      )}
    >
      {label}
      <span className="tabular-nums text-faint">{count}</span>
    </button>
  );
}
