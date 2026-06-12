"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { FileSpreadsheet, Upload, UploadCloud, X } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  matched: number;
  unmatched: string[];
  truncated?: boolean;
  totalInFile?: number;
}

const MAX_BYTES = 2 * 1024 * 1024; // mirrors the server cap
const ACCEPT_RE = /\.(xlsx|csv)$/i;

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImportUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  function clearFile() {
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  /** Validate and accept a picked or dropped file. */
  function pick(f: File | null) {
    setResult(null);
    setError(null);
    if (!f) return;
    if (!ACCEPT_RE.test(f.name)) {
      clearFile();
      setError("That doesn't look like an .xlsx or .csv file.");
      return;
    }
    if (f.size > MAX_BYTES) {
      clearFile();
      setError("That file is over 2 MB. Trim it down or split it into batches.");
      return;
    }
    setFile(f);
  }

  async function upload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      // An infrastructure-level failure can return HTML, not JSON.
      const data = await res.json().catch(() => null);
      if (!data) {
        setError(`Import failed (${res.status}). Please try again.`);
      } else if (data.error) {
        setError(data.error);
      } else {
        setResult(data as ImportResult);
        clearFile();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div>
        <h2 className="text-sm font-semibold">Import a list</h2>
        <p className="mt-0.5 text-xs text-muted">
          Upload an .xlsx or .csv with a <strong>Title</strong> column (Year, Type,
          and Status optional). Each title is matched on TMDB and added to your
          library.
        </p>
      </div>

      <label
        htmlFor="import-file"
        onDragOver={(e) => {
          e.preventDefault();
          if (!loading) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!loading) pick(e.dataTransfer.files?.[0] ?? null);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2/30 px-4 py-7 text-center transition-colors",
          "focus-within:ring-2 focus-within:ring-brand/60 hover:border-brand/40 hover:bg-surface-2/50",
          dragging && "border-brand/60 bg-brand/5",
          loading && "pointer-events-none opacity-60",
        )}
      >
        <input
          id="import-file"
          ref={inputRef}
          type="file"
          accept=".xlsx,.csv"
          className="sr-only"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        {file ? (
          <span className="flex w-full min-w-0 items-center justify-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-brand/30">
              <FileSpreadsheet size={18} />
            </span>
            <span className="min-w-0 text-left">
              <span className="block max-w-56 truncate text-sm font-medium text-foreground">
                {file.name}
              </span>
              <span className="block text-xs text-muted">
                {formatSize(file.size)} · ready to import
              </span>
            </span>
            <button
              type="button"
              aria-label="Remove selected file"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                clearFile();
              }}
              className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <span className="pointer-events-none flex flex-col items-center gap-2">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-2 text-muted ring-1 ring-line">
              <UploadCloud size={20} />
            </span>
            <span className="text-sm font-medium text-foreground/90">
              {dragging ? "Drop it here" : "Choose a file or drag it here"}
            </span>
            <span className="text-xs text-faint">.xlsx or .csv, up to 2 MB</span>
          </span>
        )}
      </label>

      {error && (
        <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
          {error}
        </p>
      )}

      {result && (
        <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300 ring-1 ring-emerald-500/20">
          Added {result.created}, updated {result.updated} · matched {result.matched}/
          {result.total} on TMDB.
          {result.truncated && (
            <span className="block text-amber-300">
              Only the first {result.total} of {result.totalInFile} rows were
              imported. Upload the rest in another batch.
            </span>
          )}{" "}
          <Link href="/" className="font-medium underline">
            View library →
          </Link>
        </div>
      )}

      {/* Bottom-right, like the app's dialogs: this card is a contained flow
          and the action concludes it (left-aligned buttons here are for
          single-field settings forms). */}
      <Button
        variant="primary"
        className="self-end"
        disabled={!file || loading}
        onClick={upload}
      >
        {loading ? <Spinner /> : <Upload size={16} />}
        {loading ? "Importing…" : "Import"}
      </Button>
    </Card>
  );
}
