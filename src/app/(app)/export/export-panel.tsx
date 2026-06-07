"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input, Select } from "@/components/ui";
import { STATUS_META, STATUS_ORDER } from "@/lib/format";
import {
  DEFAULT_SCOPE,
  FORMATS,
  type ExportRow,
  type ExportScope,
  type FormatKey,
  buildContent,
  filterRows,
  toAiPrompt,
} from "@/lib/export/format";
import { cn } from "@/lib/utils";

export function ExportPanel({
  rows,
  tags,
}: {
  rows: ExportRow[];
  tags: string[];
}) {
  const [scope, setScope] = useState<ExportScope>(DEFAULT_SCOPE);
  const [format, setFormat] = useState<FormatKey>("ai");
  const [count, setCount] = useState(15);
  const [copied, setCopied] = useState(false);

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
      window.location.href = xlsxHref(scope);
      return;
    }
    const name = format === "ai" ? "celluloid-ai-prompt" : "celluloid-library";
    const blob = new Blob([content], { type: fmt.mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${fmt.ext}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Export</h1>
        <p className="mt-1 text-sm text-muted">
          Copy or download your library. It's formatted to drop straight into an
          AI for recommendations.
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
