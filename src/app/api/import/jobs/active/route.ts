import { getActiveImportJobView } from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-active:${session.user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  try {
    return Response.json(
      { job: await getActiveImportJobView(session.user.id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("Unable to resume the active import job:", error);
    return Response.json(
      {
        job: null,
        error: "Celluloid couldn't resume the active import. Start a new upload or try again.",
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
