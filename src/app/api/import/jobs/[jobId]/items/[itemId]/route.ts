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

// Reject an oversized declared length before reading the body — the schema
// above only runs after the whole body is buffered into memory. Mirrors the
// Content-Length pre-check in the backup restore route (411/413).
const MAX_BODY_BYTES = 64 * 1024;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string; itemId: string }> },
) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-review:${session.user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) {
    return Response.json({ error: "A valid Content-Length header is required for import review updates." }, { status: 411 });
  }
  const declaredLength = Number(contentLength);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
    return Response.json({ error: "A valid Content-Length header is required for import review updates." }, { status: 411 });
  }
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "That request is too large." }, { status: 413 });
  }
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
