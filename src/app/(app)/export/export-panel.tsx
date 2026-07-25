"use client";

import { useMemo, useRef, useState } from "react";
import { Check, Copy, Download, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input, Select } from "@/components/ui";
import { STATUS_META, STATUS_ORDER } from "@/lib/format";
import {
  FORMATS,
  type ExportRow,
  type ExportScope,
  type FormatKey,
  buildContent,
  exportFilename,
  filterRows,
  sanitizeScope,
  toAiPrompt,
} from "@/lib/export/format";
import { cn } from "@/lib/utils";

const FORMAT_HELP: Record<FormatKey, string> = {
  ai: "A taste summary and recommendation request ready to paste into an AI assistant.",
  text: "A readable plain-text copy for notes, email, or quick sharing.",
  markdown: "A structured Markdown copy for documents and knowledge tools.",
  json: "A concise machine-readable copy for analysis and personal scripts.",
  xlsx: "A presentation workbook for browsing in Excel. It is not a full-fidelity Celluloid backup.",
};

export function ExportPanel({
  rows,
  tags,
  initialScope,
}: {
  rows: ExportRow[];
  tags: string[];
  /** Raw scope hints from the URL (library deep link); validated before use. */
  initialScope?: Record<string, unknown>;
}) {
  const [scope, setScope] = useState<ExportScope>(() =>
    sanitizeScope(initialScope ?? {}, rows, tags),
  );
  const [format, setFormat] = useState<FormatKey>("ai");
  const [count, setCount] = useState(15);
  const [copied, setCopied] = useState(false);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Distinct languages (code → display) and genres present in the library, so
  // the filters only ever offer values that actually match something.
  const languages = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) if (r.languageCode) map.set(r.languageCode, r.language);
    return [...map.entries()]
      .map(([code, label]) => ({ code, label }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [rows]);
  const genres = useMemo(
    () => [...new Set(rows.flatMap((r) => r.genres))].sort(),
    [rows],
  );

  const filtered = useMemo(() => filterRows(rows, scope), [rows, scope]);

  const content = useMemo(() => {
    if (format === "xlsx") return "";
    if (format === "ai") {
      // Even when the export is scoped, the "don't recommend" guardrails should
      // reflect the FULL library so a scoped prompt isn't self-contradictory.
      return toAiPrompt(filtered, count, {
        watchlist: rows.filter((r) => r.statusKey === "WATCHLIST"),
        abandoned: rows.filter((r) => r.statusKey === "DROPPED"),
      });
    }
    return buildContent(format, filtered);
  }, [format, filtered, count, rows]);

  const fmt = FORMATS.find((f) => f.key === format)!;

  function update<K extends keyof ExportScope>(key: K, value: ExportScope[K]) {
    setScope((s) => ({ ...s, [key]: value }));
  }

  function handleFormatKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % FORMATS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + FORMATS.length) % FORMATS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = FORMATS.length - 1;
    else return;
    event.preventDefault();
    setFormat(FORMATS[next].key);
    tabRefs.current[next]?.focus();
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Couldn't copy that. Select the text and copy manually.");
    }
  }

  async function download() {
    if (format === "xlsx") {
      // Fetched, never navigated to: only a successful workbook carries
      // Content-Disposition, so navigating would replace this page with the raw
      // error body on any failure — and coming back re-seeds the scope from the
      // URL, silently dropping whatever filters were set here.
      try {
        const response = await fetch(xlsxHref(scope), { cache: "no-store" });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(
            body?.error || "Celluloid couldn't build the workbook. Try again.",
          );
        }
        const disposition = response.headers.get("content-disposition") ?? "";
        saveBlob(
          await response.blob(),
          disposition.match(/filename="([^"]+)"/)?.[1] ??
            exportFilename(scope, fmt.ext, "library"),
        );
      } catch (downloadError) {
        toast.error(
          downloadError instanceof Error
            ? downloadError.message
            : "Celluloid couldn't build the workbook. Try again.",
        );
      }
      return;
    }
    saveBlob(
      new Blob([content], { type: fmt.mime }),
      exportFilename(scope, fmt.ext, format === "ai" ? "ai-prompt" : "library"),
    );
  }

  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:items-start">
      <div className="lg:col-span-2">
        <h1 className="text-xl font-semibold tracking-tight">Export</h1>
        <p className="mt-1 text-sm text-muted">
          Create a filtered copy for recommendations, sharing, or spreadsheets.
          These formats are exports, not a full-fidelity backup.
        </p>
      </div>

      <Card className="flex flex-col gap-4 p-5">
        {/* Scope */}
        <div className="flex flex-wrap items-end gap-3">
          <Labeled label="Include">
            <Select
              value={scope.type}
              onChange={(e) => update("type", e.target.value as ExportScope["type"])}
            >
              <option value="all">All types</option>
              <option value="movie">Movies</option>
              <option value="tv">TV shows</option>
            </Select>
          </Labeled>
          <Labeled label="Status">
            <Select
              value={scope.status}
              onChange={(e) =>
                update("status", e.target.value as ExportScope["status"])
              }
            >
              <option value="all">Any status</option>
              {STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {STATUS_META[s].label}
                </option>
              ))}
            </Select>
          </Labeled>
          {languages.length > 1 && (
            <Labeled label="Language">
              <Select
                value={scope.language ?? ""}
                onChange={(e) => update("language", e.target.value || null)}
              >
                <option value="">Any language</option>
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Labeled>
          )}
          {genres.length > 1 && (
            <Labeled label="Genre">
              <Select
                value={scope.genre ?? ""}
                onChange={(e) => update("genre", e.target.value || null)}
              >
                <option value="">Any genre</option>
                {genres.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </Select>
            </Labeled>
          )}
          <Labeled label="Min rating">
            <Select
              value={scope.minRating != null ? String(scope.minRating) : ""}
              onChange={(e) =>
                update("minRating", e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">Any rating</option>
              <option value="9">9+</option>
              <option value="8">8+</option>
              <option value="7">7+</option>
              <option value="6">6+</option>
              <option value="5">5+</option>
            </Select>
          </Labeled>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium text-faint">Released</legend>
            {/* min-h-10 on touch matches every other control's 40px target. */}
            <div className="flex h-10 items-center gap-1.5 sm:h-9">
              <label>
                <span className="sr-only">From year</span>
                <Input
                  name="release-year-from"
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="From…"
                  value={scope.yearFrom ?? ""}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    update("yearFrom", Number.isFinite(n) ? n : null);
                  }}
                  className="h-9 min-h-10 w-20 px-2 sm:min-h-0"
                />
              </label>
              <span className="text-xs text-faint">to</span>
              <label>
                <span className="sr-only">To year</span>
                <Input
                  name="release-year-to"
                  type="number"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="To…"
                  value={scope.yearTo ?? ""}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    update("yearTo", Number.isFinite(n) ? n : null);
                  }}
                  className="h-9 min-h-10 w-20 px-2 sm:min-h-0"
                />
              </label>
            </div>
          </fieldset>
          {tags.length > 0 && (
            <Labeled label="Tag">
              <Select
                value={scope.tag ?? ""}
                onChange={(e) => update("tag", e.target.value || null)}
              >
                <option value="">Any tag</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Labeled>
          )}
          <label className="flex h-9 min-h-11 items-center gap-2 text-sm text-muted sm:min-h-0">
            <input
              type="checkbox"
              checked={scope.favoritesOnly}
              onChange={(e) => update("favoritesOnly", e.target.checked)}
              className="h-4 w-4 accent-[var(--color-brand)]"
            />
            Favorites only
          </label>
          <span className="ml-auto self-center text-xs text-muted">
            {filtered.length} of {rows.length} titles
          </span>
        </div>

        {/* Format */}
        <div className="flex flex-wrap items-center gap-3">
          <div
            role="tablist"
            aria-label="Export format"
            className="flex flex-wrap gap-1.5"
          >
            {FORMATS.map((f, index) => (
              <button
                key={f.key}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                id={`export-tab-${f.key}`}
                type="button"
                role="tab"
                aria-selected={format === f.key}
                aria-controls="export-preview"
                aria-describedby="export-format-help"
                tabIndex={format === f.key ? 0 : -1}
                onClick={() => setFormat(f.key)}
                onKeyDown={(event) => handleFormatKeyDown(event, index)}
                className={cn(
                  "focus-ring flex min-h-11 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors sm:min-h-0",
                  format === f.key
                    ? "bg-surface-2 text-foreground ring-brand/40"
                    : "text-muted ring-line hover:text-foreground",
                )}
              >
                {f.key === "ai" && <Sparkles size={14} aria-hidden="true" />}
                {f.label}
              </button>
            ))}
          </div>
          {format === "ai" && (
            <label className="flex items-center gap-2 text-sm text-muted">
              Recommend
              <Input
                name="recommendation-count"
                type="number"
                min={1}
                max={50}
                value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(50, +e.target.value || 1)))}
                className="h-9 w-16 px-2 text-center"
              />
            </label>
          )}
        </div>
        <p id="export-format-help" className="text-xs text-muted">
          {FORMAT_HELP[format]}
        </p>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={copy}
            disabled={format === "xlsx" || filtered.length === 0}
          >
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            {copied ? "Copied" : format === "ai" ? "Copy AI prompt" : "Copy"}
          </Button>
          <Button onClick={download} disabled={filtered.length === 0}>
            <Download size={16} aria-hidden="true" />
            Download {fmt.ext.toUpperCase()}
          </Button>
        </div>
      </Card>

      <div className="flex flex-col gap-5">
        <p role="status" aria-live="polite" className="sr-only">
          {copied ? "Export copied to the clipboard." : ""}
        </p>

        {/* Preview */}
        {format === "xlsx" ? (
          <div
            id="export-preview"
            role="tabpanel"
            aria-labelledby="export-tab-xlsx"
            tabIndex={0}
            className="focus-ring rounded-xl"
          >
            <Card className="p-8 text-center text-sm text-muted">
              A styled presentation workbook ({filtered.length} titles) with separate
              Movies and TV Shows sheets. It cannot currently restore every Celluloid
              field, so keep a database backup as the recovery copy.
            </Card>
          </div>
        ) : (
          <div
            id="export-preview"
            role="tabpanel"
            aria-labelledby={`export-tab-${format}`}
            tabIndex={0}
            className="focus-ring rounded-xl"
          >
            <Card className="overflow-hidden">
              <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90">
                {content || "Nothing to export with these filters."}
              </pre>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Save a blob under `filename`. The anchor has to be in the document for the
 * synthetic click to count in every browser, and the object URL has to outlive
 * that click — revoking it in the same tick races the download in some of them,
 * so the revoke is deferred to the next task instead.
 */
function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function xlsxHref(scope: ExportScope): string {
  const p = new URLSearchParams();
  if (scope.type !== "all") p.set("type", scope.type);
  if (scope.status !== "all") p.set("status", scope.status);
  if (scope.favoritesOnly) p.set("fav", "1");
  if (scope.tag) p.set("tag", scope.tag);
  if (scope.language) p.set("lang", scope.language);
  if (scope.genre) p.set("genre", scope.genre);
  if (scope.minRating != null) p.set("min", String(scope.minRating));
  if (scope.yearFrom != null) p.set("from", String(scope.yearFrom));
  if (scope.yearTo != null) p.set("to", String(scope.yearTo));
  const qs = p.toString();
  return `/api/export/xlsx${qs ? `?${qs}` : ""}`;
}

function Labeled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-faint">{label}</span>
      {children}
    </label>
  );
}
