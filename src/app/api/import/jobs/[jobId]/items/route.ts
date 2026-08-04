import { z } from "zod";
import { excludeImportItems } from "@/lib/import-staging";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";

// A job is capped at 250 rows, so a selection can never legitimately exceed
// that; the bound also keeps a crafted body from building an enormous IN list.
const bulkExcludeSchema = z
  .object({
    exclude: z.literal(true),
    itemIds: z.array(z.string().min(1).max(64)).min(1).max(250),
  })
  .strict();

// Reject an oversized declared length before reading the body — the schema
// above only runs after the whole body is buffered into memory. Mirrors the
// Content-Length pre-check in the backup restore route (411/413).
const MAX_BODY_BYTES = 64 * 1024;

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
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
  const body = bulkExcludeSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "Invalid import review update." }, { status: 400 });
  }
  const { jobId } = await params;
  const job = await excludeImportItems({
    userId: session.user.id,
    jobId,
    itemIds: body.data.itemIds,
  });
  if (!job) {
    return Response.json({ error: "Import not found or no longer editable." }, { status: 404 });
  }
  return Response.json({ job }, { headers: { "Cache-Control": "private, no-store" } });
}
