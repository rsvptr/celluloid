"use client";

import { useEffect, useRef, useState } from "react";
import { FileSpreadsheet, RotateCcw, Upload, UploadCloud, X } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";
import { ImportReview } from "@/components/import-review";
import type { StagedImportJobView } from "@/lib/import-staging-views";
import { cn } from "@/lib/utils";

const MAX_BYTES = 2 * 1024 * 1024;
const ACCEPT_RE = /\.(xlsx|csv)$/i;
const ACTIVE_CHECK_ERROR =
  "Celluloid couldn't verify whether an import is already unfinished. Uploads are paused until this check succeeds.";

async function fetchActiveImport(signal?: AbortSignal): Promise<StagedImportJobView | null> {
  const response = await fetch("/api/import/jobs/active", {
    cache: "no-store",
    signal,
  });
  const body = (await response.json().catch(() => null)) as
    | { job?: StagedImportJobView | null; error?: string }
    | null;
  if (!response.ok) {
    throw new Error(body?.error ?? ACTIVE_CHECK_ERROR);
  }
  if (!body || !("job" in body)) {
    throw new Error(ACTIVE_CHECK_ERROR);
  }
  return body.job ?? null;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImportUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingActive, setLoadingActive] = useState(true);
  const [activeError, setActiveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<StagedImportJobView | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchActiveImport(controller.signal)
      .then((activeJob) => setJob(activeJob))
      .catch((activeError) => {
        if (!(activeError instanceof Error) || activeError.name !== "AbortError") {
          setActiveError(activeError instanceof Error ? activeError.message : ACTIVE_CHECK_ERROR);
        }
      })
      .finally(() => setLoadingActive(false));
    return () => controller.abort();
  }, []);

  async function retryActiveCheck() {
    setLoadingActive(true);
    setActiveError(null);
    try {
      setJob(await fetchActiveImport());
    } catch (activeCheckError) {
      setActiveError(
        activeCheckError instanceof Error ? activeCheckError.message : ACTIVE_CHECK_ERROR,
      );
    } finally {
      setLoadingActive(false);
    }
  }

  function clearFile() {
    setFile(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function pick(next: File | null) {
    setError(null);
    if (!next) return;
    if (!ACCEPT_RE.test(next.name)) {
      clearFile();
      setError("That doesn't look like an .xlsx or .csv file.");
      return;
    }
    if (next.size > MAX_BYTES) {
      clearFile();
      setError("That file is over 2 MB. Trim it down or split it into batches.");
      return;
    }
    setFile(next);
  }

  async function upload() {
    if (!file || loadingActive || activeError) return;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/import", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as
        | { job?: StagedImportJobView; error?: string }
        | null;
      if (!response.ok || !body?.job) {
        throw new Error(body?.error ?? `Import setup failed (${response.status}). Try again.`);
      }
      setJob(body.job);
      clearFile();
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "Celluloid couldn't prepare that import. Check your connection and retry.",
      );
    } finally {
      setLoading(false);
    }
  }

  if (job) {
    return (
      <ImportReview
        initialJob={job}
        onStartAnother={() => {
          setJob(null);
          setError(null);
        }}
      />
    );
  }

  const uploadBlocked = loading || loadingActive || activeError !== null;

  return (
    <Card className="flex flex-col gap-4 p-5" aria-busy={loading || loadingActive}>
      <div>
        <h2 className="text-sm font-semibold">Import a list</h2>
        <p className="mt-0.5 text-xs text-muted">
          Upload an .xlsx or .csv with a <strong>Title</strong> column. Celluloid
          proposes TMDB matches first, so you can review every row before anything
          enters your library.
        </p>
      </div>

      <label
        htmlFor="import-file"
        onDragOver={(event) => {
          event.preventDefault();
          if (!uploadBlocked) setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!uploadBlocked) pick(event.dataTransfer.files?.[0] ?? null);
        }}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2/30 px-4 py-7 text-center transition-colors",
          "focus-within:ring-2 focus-within:ring-brand/60 hover:border-brand/40 hover:bg-surface-2/50",
          dragging && "border-brand/60 bg-brand/5",
          uploadBlocked && "pointer-events-none opacity-60",
        )}
      >
        <input
          id="import-file"
          ref={inputRef}
          name="library-import"
          type="file"
          accept=".xlsx,.csv"
          disabled={uploadBlocked}
          className="sr-only"
          onChange={(event) => pick(event.target.files?.[0] ?? null)}
        />
        {file ? (
          <span className="flex w-full min-w-0 items-center justify-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand ring-1 ring-brand/30">
              <FileSpreadsheet size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block max-w-56 truncate text-sm font-medium">{file.name}</span>
              <span className="block text-xs text-muted">{formatSize(file.size)} · ready to review</span>
            </span>
            <button
              type="button"
              aria-label="Remove selected file"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearFile();
              }}
              className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-foreground sm:h-8 sm:w-8"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <>
            <UploadCloud size={24} aria-hidden="true" className="text-brand" />
            <span className="text-sm font-medium">Choose a spreadsheet or drop it here</span>
            <span className="text-xs text-muted">.xlsx or .csv · up to 2 MB</span>
          </>
        )}
      </label>

      {loadingActive ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> Checking for an unfinished import…
        </p>
      ) : null}

      {activeError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20"
        >
          <p>{activeError}</p>
          <Button type="button" variant="secondary" size="sm" onClick={retryActiveCheck}>
            <RotateCcw size={14} aria-hidden="true" /> Retry check
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-lg bg-rose-500/10 px-3 py-2 text-sm text-rose-300 ring-1 ring-rose-500/20">
          {error}
        </p>
      ) : null}

      <Button
        type="button"
        variant="primary"
        size="sm"
        className="self-start"
        disabled={!file || uploadBlocked}
        onClick={upload}
      >
        {loading ? <Spinner /> : <Upload size={15} aria-hidden="true" />}
        {loading ? "Finding matches…" : "Review matches"}
      </Button>
    </Card>
  );
}
