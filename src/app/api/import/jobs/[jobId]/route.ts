import { getImportJobView } from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-status:${session.user.id}`, 60, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  const { jobId } = await params;
  const job = await getImportJobView(session.user.id, jobId);
  if (!job) return Response.json({ error: "Import not found." }, { status: 404 });
  return Response.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
}
