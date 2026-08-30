import {
  commitImportJobChunk,
  IMPORT_COMMIT_BUDGET_MS,
} from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  // Start the budget before authentication/rate-limit awaits so the commit
  // worker receives a true request-level deadline, not a fresh 45 seconds after
  // setup has already consumed part of the platform's 60-second allowance.
  const deadlineAt = Date.now() + IMPORT_COMMIT_BUDGET_MS;
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  // 250 staged rows take around 38 chunks in the all-fail/retry worst case at
  // the current batch size. Keep the abuse bound while allowing one legitimate
  // run to settle without tripping its own per-user limiter.
  const limited = rateLimit(`import-commit:${session.user.id}`, 240, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  const { jobId } = await params;
  const job = await commitImportJobChunk(session.user.id, jobId, deadlineAt);
  if (!job) return Response.json({ error: "Import not found." }, { status: 404 });
  return Response.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
}
