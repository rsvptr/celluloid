"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Search, Star } from "lucide-react";
import type { SearchResult } from "@/app/api/search/route";
import { Input, Spinner } from "@/components/ui";
import { Poster } from "@/components/poster";
import { languageName } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * Debounced TMDB search with result rows. Two modes:
 *  - `renderAction` — render a custom control on the right of each row (Add page).
 *  - `onPick` — the whole row is clickable and calls back with the result (match dialog).
 */
export function TmdbSearch({
  onPick,
  renderAction,
  autoFocus,
  initialQuery = "",
  placeholder = "Search for a movie or TV show…",
}: {
  onPick?: (r: SearchResult) => void;
  renderAction?: (r: SearchResult) => React.ReactNode;
  autoFocus?: boolean;
  initialQuery?: string;
  placeholder?: string;
}) {
  const inputId = useId();
  const [query, setQuery] = useState(initialQuery);
  // Results are keyed by the query that produced them. Loading, "no results" and
  // the idle hint all derive from comparing that key to the current query, so a
  // query change never needs a reset-state-in-effect (stale data derives away).
  const [data, setData] = useState<
    | { q: string; status: "success"; results: SearchResult[] }
    | { q: string; status: "error"; message: string }
    | null
  >(null);
  const [retryKey, setRetryKey] = useState(0);
  const reqId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const q = query.trim();
  const active = q.length >= 2; // don't fire a TMDB request for a single character
  const current = active && data?.q === q ? data : null;
  const searched = current?.status === "success";
  const results = searched ? current.results : [];
  const loading = active && !current;

  useEffect(() => {
    if (!autoFocus || !window.matchMedia("(min-width: 768px)").matches) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(inputId)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, inputId]);

  useEffect(() => {
    const qq = query.trim();
    if (qq.length < 2) return;
    const id = ++reqId.current;
    let controller: AbortController | null = null;
    const t = setTimeout(async () => {
      controller = new AbortController();
      activeRequest.current?.abort();
      activeRequest.current = controller;
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(qq)}`, {
          signal: controller.signal,
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json) {
          const message =
            res.status === 429
              ? "TMDB is receiving too many requests. Wait a moment, then retry."
              : "TMDB could not be reached. Check your connection and retry.";
          if (id === reqId.current) setData({ q: qq, status: "error", message });
          return;
        }
        if (id === reqId.current) {
          setData({ q: qq, status: "success", results: json.results ?? [] });
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        if (id === reqId.current) {
          setData({
            q: qq,
            status: "error",
            message: "TMDB could not be reached. Check your connection and retry.",
          });
        }
      } finally {
        if (activeRequest.current === controller) activeRequest.current = null;
      }
    }, 350);
    return () => {
      clearTimeout(t);
      controller?.abort();
      if (activeRequest.current === controller) activeRequest.current = null;
    };
  }, [query, retryKey]);

  function retry() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setData(null);
    setRetryKey((value) => value + 1);
  }

  return (
    // @container: the results grid keys its columns off this component's
    // width, not the viewport — TmdbSearch also renders inside the ~512px
    // change-match dialog, where viewport breakpoints would wrongly force two
    // cramped columns on wide screens.
    <div className="@container flex flex-col gap-4" aria-busy={loading}>
      <div className="relative">
        <Search
          size={20}
          aria-hidden="true"
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <Input
          id={inputId}
          name="tmdb-search"
          type="search"
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          aria-label="Search The Movie Database"
          spellCheck={false}
          // While the spinner shows, it takes the native clear button's
          // place instead of sitting on top of it (JK-36).
          className={cn(
            "h-12 pl-11 text-base",
            loading && "pr-11 [&::-webkit-search-cancel-button]:hidden",
          )}
        />
        {loading && (
          <Spinner className="absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
        )}
      </div>

      <p role="status" aria-live="polite" className="sr-only">
        {loading
          ? "Searching TMDB…"
          : searched
            ? `${results.length} ${results.length === 1 ? "result" : "results"} found.`
            : ""}
      </p>

      {current?.status === "error" ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-xl bg-rose-500/10 px-4 py-6 text-center text-sm text-rose-200 ring-1 ring-rose-500/25"
        >
          <p>{current.message}</p>
          <button
            type="button"
            onClick={retry}
            className="focus-ring min-h-11 rounded-lg bg-rose-500/15 px-3 py-2 font-medium text-rose-100 ring-1 ring-rose-500/30 hover:bg-rose-500/25 sm:min-h-0"
          >
            Retry search
          </button>
        </div>
      ) : null}

      {searched && results.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          No results for “{query}”.
        </p>
      ) : null}

      {!searched && !loading && query.trim().length < 2 && (
        <p className="py-10 text-center text-sm text-faint">
          Start typing to search The Movie Database.
        </p>
      )}

      {/* role="group": a bare <div> has no role to hang a name on, so the
          aria-label was dropped on the floor and the results arrived unlabelled. */}
      <div
        role="group"
        aria-label="TMDB search results"
        className="grid grid-cols-1 gap-2 @3xl:grid-cols-2"
      >
        {results.map((r) => (
          <ResultRow
            key={`${r.mediaType}:${r.tmdbId}`}
            r={r}
            onPick={onPick}
            action={renderAction?.(r)}
          />
        ))}
      </div>
    </div>
  );
}

function ResultRow({
  r,
  onPick,
  action,
}: {
  r: SearchResult;
  onPick?: (r: SearchResult) => void;
  action?: React.ReactNode;
}) {
  const showOriginal = r.originalName && r.originalName !== r.name;

  const body = (
    <>
      <div className="w-12 shrink-0">
        <Poster
          path={r.posterPath}
          name={r.name}
          decorative
          mediaType={r.mediaType === "tv" ? "TV" : "MOVIE"}
          size="w154"
          sizes="48px"
        />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-medium">{r.name}</span>
          {showOriginal && (
            <span className="text-xs italic text-faint">{r.originalName}</span>
          )}
          <span className="text-xs text-muted">
            {r.mediaType === "tv" ? "TV" : "Movie"}
            {r.year ? ` · ${r.year}` : ""}
            {r.language ? ` · ${languageName(r.language)}` : ""}
          </span>
          {r.tmdbRating ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-amber-300">
              <Star size={10} aria-hidden="true" className="fill-amber-300" />
              {r.tmdbRating.toFixed(1)}
            </span>
          ) : null}
        </div>
        {r.overview && (
          <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.overview}</p>
        )}
      </div>
      {action}
    </>
  );

  if (onPick) {
    return (
      <button
        type="button"
        onClick={() => onPick(r)}
        className={cn(
          "focus-ring flex w-full min-w-0 items-center gap-3 rounded-2xl bg-surface p-2.5 text-left ring-1 ring-line transition-colors hover:bg-surface-2/60 hover:ring-brand/40",
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-2xl bg-surface p-2.5 ring-1 ring-line">
      {body}
    </div>
  );
}
