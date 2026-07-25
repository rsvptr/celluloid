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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(`import-review:${session.user.id}`, 120, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);
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
