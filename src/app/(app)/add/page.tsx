import type { Metadata } from "next";
import { requireUser } from "@/lib/session";
import { AddSearch } from "./add-search";
import { ImportUpload } from "./import-upload";

export const metadata: Metadata = { title: "Add" };

export default async function AddPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireUser();
  const { q } = await searchParams;
  const initialQuery = Array.isArray(q) ? q[0] : q;
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <AddSearch initialQuery={initialQuery} />
      <div className="border-t border-line pt-6">
        <ImportUpload />
      </div>
    </div>
  );
}
