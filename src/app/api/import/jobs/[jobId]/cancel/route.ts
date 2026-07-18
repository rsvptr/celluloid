import { cancelImportJob } from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-cancel:${session.user.id}`, 30, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  const { jobId } = await params;
  const ok = await cancelImportJob(session.user.id, jobId);
  return ok
    ? Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } })
    : Response.json({ error: "Import not found or already closed." }, { status: 404 });
}
