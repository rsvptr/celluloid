"use client";

import { ChevronDown } from "lucide-react";
import { Select } from "@/components/ui";
import { REC_ERAS } from "@/lib/models";
import { languageName } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TitlePicker } from "./title-picker";

/** The brief's "Tune results" section: source titles, language, genre and era. */
export function TuneResults({
  loading,
  hasWatchDates,
  basisMode,
  setBasisMode,
  recentCount,
  setRecentCount,
  pickedIds,
  togglePicked,
  clearPicked,
  languages,
  language,
  setLanguage,
  genres,
  genre,
  setGenre,
  era,
  setEra,
}: {
  loading: boolean;
  hasWatchDates: boolean;
  basisMode: "all" | "recent" | "pick";
  setBasisMode: (mode: "all" | "recent" | "pick") => void;
  recentCount: 10 | 20 | 50;
  setRecentCount: (count: 10 | 20 | 50) => void;
  pickedIds: Set<string>;
  togglePicked: (id: string) => void;
  clearPicked: () => void;
  languages: string[];
  language: string;
  setLanguage: (language: string) => void;
  genres: string[];
  genre: string;
  setGenre: (genre: string) => void;
  era: string;
  setEra: (era: string) => void;
}) {
  return (
    <details className="group rounded-xl bg-surface-2/30 ring-1 ring-line">
      <summary className="focus-ring flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-medium marker:text-faint">
        <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
          Tune results
          <span className="text-xs font-normal text-faint">
            Language, genre, era &amp; source titles
          </span>
        </span>
        <span
          aria-hidden="true"
          className="shrink-0 transition-transform duration-200 group-open:rotate-180"
        >
          <ChevronDown size={16} />
        </span>
      </summary>
      <div className="flex flex-col gap-4 border-t border-line px-3 py-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-faint">
            Base suggestions on
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ["all", "Whole library"],
                ["recent", "Recent watches"],
                ["pick", "Pick titles"],
              ] as const
            ).map(([mode, label]) => {
              const disabledTab = mode === "recent" && !hasWatchDates;
              return (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={basisMode === mode}
                  disabled={loading || disabledTab}
                  title={
                    disabledTab
                      ? "Available after you record at least one watch date"
                      : undefined
                  }
                  onClick={() => setBasisMode(mode)}
                  className={cn(
                    "focus-ring min-h-11 rounded-lg px-3 py-1.5 text-sm ring-1 press disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0",
                    basisMode === mode
                      ? "bg-brand/15 text-brand ring-brand/40"
                      : "text-muted ring-line hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </fieldset>

        {basisMode === "recent" ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {([10, 20, 50] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={recentCount === value}
                disabled={loading}
                onClick={() => setRecentCount(value)}
                className={cn(
                  "focus-ring min-h-11 rounded-full px-3 py-1 text-sm ring-1 press disabled:opacity-50 sm:min-h-0",
                  recentCount === value
                    ? "bg-brand/15 text-brand ring-brand/40"
                    : "text-muted ring-line hover:text-foreground",
                )}
              >
                Last {value}
              </button>
            ))}
            <span className="text-xs text-faint">
              Uses titles with a recorded watch date.
            </span>
          </div>
        ) : null}

        {basisMode === "pick" ? (
          <TitlePicker
            selected={pickedIds}
            onToggle={togglePicked}
            onClear={clearPicked}
          />
        ) : null}

        <div className="grid gap-3 sm:grid-cols-3">
          {languages.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-faint">Language</span>
              <Select
                name="recommendation-language"
                value={language}
                disabled={loading}
                onChange={(event) => setLanguage(event.target.value)}
              >
                <option value="">Any language</option>
                {languages.map((value) => (
                  <option key={value} value={value}>
                    {languageName(value)}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          {genres.length > 0 ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-faint">Genre</span>
              <Select
                name="recommendation-genre"
                value={genre}
                disabled={loading}
                onChange={(event) => setGenre(event.target.value)}
              >
                <option value="">Any genre</option>
                {genres.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-faint">Era</span>
            <Select
              name="recommendation-era"
              value={era}
              disabled={loading}
              onChange={(event) => setEra(event.target.value)}
            >
              <option value="">Any era</option>
              {REC_ERAS.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
    </details>
  );
}
