"use client";

import { useState } from "react";
import Link from "next/link";
import { Upload } from "lucide-react";
import { Button, Card, Spinner } from "@/components/ui";

interface ImportResult {
  total: number;
  created: number;
  updated: number;
  matched: number;
  unmatched: string[];
  truncated?: boolean;
  totalInFile?: number;
}

export function ImportUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  async function upload() {
    if (!file) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body: fd });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setResult(data as ImportResult);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-sm font-semibold">Import a list</h2>
        <p className="mt-0.5 text-xs text-muted">
          Upload an .xlsx or .csv with a <strong>Title</strong> column (Year, Type,
          and Status optional). Each title is matched on TMDB and added to your
          library.
        </p>
      </div>

      <input
        type="file"
        accept=".xlsx,.csv"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setResult(null);
          setError(null);
        }}
        className="text-sm text-muted file:mr-3 file:cursor-pointer file:rounded-lg file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground hover:file:bg-surface-2/70"
      />

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

      <Button
        variant="primary"
        className="self-start"
        disabled={!file || loading}
        onClick={upload}
      >
        {loading ? <Spinner /> : <Upload size={16} />}
        {loading ? "Importing…" : "Import"}
      </Button>
    </Card>
  );
}
