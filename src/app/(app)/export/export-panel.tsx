"use client";

import { useMemo, useState } from "react";
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

  function download() {
    if (format === "xlsx") {
      window.location.assign(xlsxHref(scope));
      return;
    }
    const blob = new Blob([content], { type: fmt.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exportFilename(scope, fmt.ext, format === "ai" ? "ai-prompt" : "library");
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Export</h1>
        <p className="mt-1 text-sm text-muted">
          Copy or download your library. It&apos;s formatted to drop straight
          into an AI for recommendations.
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
          <Labeled label="Released">
            {/* min-h-10 on touch matches every other control's 40px target. */}
            <div className="flex h-10 items-center gap-1.5 sm:h-9">
              <Input
                type="number"
                inputMode="numeric"
                placeholder="From"
                value={scope.yearFrom ?? ""}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  update("yearFrom", Number.isFinite(n) ? n : null);
                }}
                className="h-9 min-h-10 w-20 px-2 sm:min-h-0"
              />
              <span className="text-xs text-faint">to</span>
              <Input
                type="number"
                inputMode="numeric"
                placeholder="To"
                value={scope.yearTo ?? ""}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  update("yearTo", Number.isFinite(n) ? n : null);
                }}
                className="h-9 min-h-10 w-20 px-2 sm:min-h-0"
              />
            </div>
          </Labeled>
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
          <label className="flex h-9 items-center gap-2 text-sm text-muted">
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
        <div className="flex flex-wrap gap-1.5">
          {FORMATS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFormat(f.key)}
              className={cn(
                "focus-ring flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm ring-1 transition-colors",
                format === f.key
                  ? "bg-surface-2 text-foreground ring-brand/40"
                  : "text-muted ring-line hover:text-foreground",
              )}
            >
              {f.key === "ai" && <Sparkles size={14} />}
              {f.label}
            </button>
          ))}
          {format === "ai" && (
            <label className="ml-2 flex items-center gap-2 text-sm text-muted">
              Recommend
              <Input
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

        {/* Actions */}
        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            onClick={copy}
            disabled={format === "xlsx" || filtered.length === 0}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? "Copied!" : format === "ai" ? "Copy AI prompt" : "Copy"}
          </Button>
          <Button onClick={download} disabled={filtered.length === 0}>
            <Download size={16} />
            Download {fmt.ext.toUpperCase()}
          </Button>
        </div>
      </Card>

      {/* Preview */}
      {format === "xlsx" ? (
        <Card className="p-8 text-center text-sm text-muted">
          A styled Excel workbook ({filtered.length} titles) with separate Movies
          and TV Shows sheets. Click “Download XLSX”.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-foreground/90">
            {content || "Nothing to export with these filters."}
          </pre>
        </Card>
      )}
    </div>
  );
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
