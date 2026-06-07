"use client";

import { useEffect, useRef, useState } from "react";
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
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Don't fire a TMDB request for a single character.
      setResults([]);
      setSearched(false);
      return;
    }
    const id = ++reqId.current;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
        const data = await res.json();
        if (id === reqId.current) {
          setResults(data.results ?? []);
          setSearched(true);
        }
      } catch {
        if (id === reqId.current) setResults([]);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search
          size={18}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
        />
        <Input
          autoFocus={autoFocus}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          className="h-12 pl-11 text-base"
        />
        {loading && (
          <Spinner className="absolute right-4 top-1/2 -translate-y-1/2 text-muted" />
        )}
      </div>

      {searched && results.length === 0 && !loading && (
        <p className="py-10 text-center text-sm text-muted">
          No results for “{query}”.
        </p>
      )}

      {!searched && !loading && query.trim().length < 2 && (
        <p className="py-10 text-center text-sm text-faint">
          Start typing to search The Movie Database.
        </p>
      )}

      <div className="flex flex-col gap-2">
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
              <Star size={10} className="fill-amber-300" />
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
          "focus-ring flex w-full items-center gap-3 rounded-xl bg-surface p-2.5 text-left ring-1 ring-line transition-colors hover:bg-surface-2/60 hover:ring-brand/40",
        )}
      >
        {body}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-3 rounded-xl bg-surface p-2.5 ring-1 ring-line">
      {body}
    </div>
  );
}
