import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { getExportRows, getTags } from "@/lib/data";
import { ExportPanel } from "./export-panel";

export const metadata: Metadata = { title: "Export" };

export default async function ExportPage() {
  const user = await requireUser();
  const [rows, tags] = await Promise.all([
    getExportRows(user.id),
    getTags(user.id),
  ]);

  return (
    <div className="mx-auto max-w-3xl">
      <ExportPanel rows={rows} tags={tags.map((t) => t.name)} />
    </div>
  );
}
