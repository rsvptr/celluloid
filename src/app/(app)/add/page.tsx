import type { Metadata } from "next";
import { Suspense } from "react";
import { Shimmer } from "@/components/skeleton";
import { getActiveImportJobView } from "@/lib/import-staging";
import { requireUser } from "@/lib/session";
import { AddSearch } from "./add-search";
import { ImportUpload } from "./import-upload";

export const metadata: Metadata = { title: "Add" };

export default async function AddPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const user = await requireUser();
  const { q } = await searchParams;
  const initialQuery = Array.isArray(q) ? q[0] : q;
  return (
    // Full shell width (D-UI-17 amendment): every tab shares the layout's
    // max-w-7xl; no per-page cap.
    <div className="flex flex-col gap-8">
      <AddSearch initialQuery={initialQuery} />
      <div className="border-t border-line pt-6">
        {/* Streams in after the search, so the import check never holds it up. */}
        <Suspense fallback={<Shimmer className="h-64" />}>
          <ActiveImportUpload userId={user.id} />
        </Suspense>
      </div>
    </div>
  );
}

/**
 * Looks up an unfinished import on the server (VE-12), with the same query as
 * GET /api/import/jobs/active: stale PARSING jobs are retired first, then the
 * latest open job is read. On failure, uploads stay paused behind the same
 * message and Retry check that route's 503 gives.
 */
async function ActiveImportUpload({ userId }: { userId: string }) {
  let job = null;
  let error = null;
  try {
    job = await getActiveImportJobView(userId);
  } catch (lookupError) {
    console.error("Unable to resume the active import job:", lookupError);
    error = "Celluloid couldn't verify unfinished imports. Uploads are paused; try again.";
  }
  return <ImportUpload initialJob={job} initialActiveError={error} />;
}
