import { z } from "zod";
import { proposedMatchSchema } from "@/lib/import-staging-format";
import { updateImportItemReview } from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

const reviewUpdateSchema = z
  .union([
    z.object({ exclude: z.boolean() }).strict(),
    z.object({ proposed: proposedMatchSchema }).strict(),
    z.object({ retry: z.literal(true) }).strict(),
  ]);

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string; itemId: string }> },
) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-review:${session.user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  const body = reviewUpdateSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "Invalid import review update." }, { status: 400 });
  }
  const { jobId, itemId } = await params;
  const job = await updateImportItemReview({
    userId: session.user.id,
    jobId,
    itemId,
    ...(body.data),
  });
  if (!job) return Response.json({ error: "Import row not found or no longer editable." }, { status: 404 });
  return Response.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
}
