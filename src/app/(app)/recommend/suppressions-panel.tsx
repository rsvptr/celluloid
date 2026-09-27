"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { ChevronDown, Film, RotateCcw, Search, Tv } from "lucide-react";
import { toast } from "sonner";
import {
  listSuppressions,
  unsuppressSuggestion,
  type SuppressionEntry,
} from "@/lib/suppression-actions";
import { Card, Input, Spinner } from "@/components/ui";

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
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [enforcedLimit, setEnforcedLimit] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const activeSearch = useRef("");
  const [, start] = useTransition();

  useEffect(() => {
    const nextQuery = query.trim();
    if (nextQuery === searchQuery) return;
    const timer = setTimeout(() => {
      setLoading(true);
      setSearchQuery(nextQuery);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, searchQuery]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    activeSearch.current = searchQuery;
    listSuppressions(searchQuery ? { query: searchQuery } : {})
      .then((page) => {
        if (!cancelled) {
          setEntries(page.entries);
          setTotal(page.total);
          setNextOffset(page.nextOffset);
          setEnforcedLimit(page.enforcedLimit);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(
            "Your hidden titles could not be loaded. Check your connection and retry.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, refreshKey, retryKey, searchQuery]);

  async function loadMore() {
    if (nextOffset === null || loadingMore || pendingId !== null) return;
    const requestedSearch = searchQuery;
    const offset = nextOffset;
    setLoadingMore(true);
    try {
      const page = await listSuppressions({
        ...(requestedSearch ? { query: requestedSearch } : {}),
        offset,
      });
      if (activeSearch.current !== requestedSearch) return;
      setEntries((current) => {
        const byId = new Map((current ?? []).map((entry) => [entry.id, entry]));
        for (const entry of page.entries) byId.set(entry.id, entry);
        return [...byId.values()];
      });
      setTotal(page.total);
      setNextOffset(page.nextOffset);
      setEnforcedLimit(page.enforcedLimit);
    } catch {
      toast.error("Celluloid couldn't load more hidden titles. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

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
        setTotal((current) => Math.max(0, current - 1));
        setNextOffset((current) =>
          current === null ? null : Math.max(0, current - 1),
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
        onToggle={(event) => {
          const isOpen = event.currentTarget.open;
          if (isOpen) setLoading(true);
          setOpen(isOpen);
        }}
        className="group rounded-[var(--radius-card)]"
      >
        <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-[var(--radius-card)] px-4 py-3 text-sm font-medium marker:text-faint">
          <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
            Not interested
            <span className="text-xs font-normal text-faint">
              Titles hidden from future suggestions
            </span>
          </span>
          <span
            aria-hidden="true"
            className="shrink-0 transition-transform duration-200 group-open:rotate-180"
          >
            <ChevronDown size={16} />
          </span>
        </summary>
        <div className="flex flex-col gap-3 border-t border-line px-4 py-4">
          <label className="relative block">
            <span className="sr-only">Search hidden titles</span>
            <Search
              size={16}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
            />
            <Input
              type="search"
              name="hidden-title-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search hidden titles…"
              autoComplete="off"
              maxLength={100}
              className="pl-9"
            />
          </label>
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
                  setLoading(true);
                  setRetryKey((value) => value + 1);
                }}
                className="focus-ring min-h-11 rounded-lg px-3 py-1.5 font-medium ring-1 ring-rose-500/30 hover:bg-rose-500/10 sm:min-h-0"
              >
                Retry
              </button>
            </div>
          ) : loading ? (
            <p role="status" className="py-2 text-center text-xs text-muted">
              {entries === null ? "Loading hidden titles…" : "Searching hidden titles…"}
            </p>
          ) : entries === null ? null : entries.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted">
              {searchQuery
                ? `No hidden titles match “${searchQuery}”.`
                : "Nothing hidden yet. Dismissing a suggestion keeps it out of future runs."}
            </p>
          ) : (
            <>
              <p role="status" className="text-xs text-faint">
                {searchQuery
                  ? `Showing ${entries.length} of ${total} matching hidden titles.`
                  : `Showing the newest ${entries.length} of ${total} hidden titles.`}
                {nextOffset !== null
                  ? searchQuery
                    ? " Load more to see the remaining matches."
                    : " Search for an older title or load more."
                  : ""}
              </p>
              {!searchQuery && enforcedLimit !== null && total > enforcedLimit ? (
                <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-500/20">
                  Celluloid keeps the newest {enforcedLimit.toLocaleString()} hidden
                  titles out of recommendations. Older entries remain here so you can
                  find and restore them.
                </p>
              ) : null}
              <ul className="flex max-h-80 flex-col gap-1 overflow-y-auto overscroll-contain">
                {entries.map((entry) => {
                  const Icon = entry.mediaType === "tv" ? Tv : Film;
                  return (
                    <li
                      key={entry.id}
                      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm"
                    >
                      <Icon size={16} aria-hidden="true" className="shrink-0 text-muted" />
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
                        disabled={pendingId !== null || loadingMore}
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
              {nextOffset !== null ? (
                <button
                  type="button"
                  disabled={loadingMore || pendingId !== null}
                  onClick={() => void loadMore()}
                  className="focus-ring self-center rounded-lg px-3 py-2 text-xs font-medium text-muted ring-1 ring-line transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </details>
    </Card>
  );
}
