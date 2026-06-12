import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { getExportRows, getTags } from "@/lib/data";
import { ExportPanel } from "./export-panel";

export const metadata: Metadata = { title: "Export" };

export default async function ExportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [rows, tags, sp] = await Promise.all([
    getExportRows(user.id),
    getTags(user.id),
    searchParams,
  ]);

  // Scope hints from a library "Export these" deep link. Raw here; the panel
  // validates everything against the actual library before applying.
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const initialScope = {
    type: one("type"),
    status: one("status"),
    tag: one("tag"),
    genre: one("genre"),
    language: one("lang"),
    minRating: one("min"),
    yearFrom: one("from"),
    yearTo: one("to"),
    favoritesOnly: one("fav"),
  };

  return (
    <div className="mx-auto max-w-3xl">
      <ExportPanel
        rows={rows}
        tags={tags.map((t) => t.name)}
        initialScope={initialScope}
      />
    </div>
  );
}
