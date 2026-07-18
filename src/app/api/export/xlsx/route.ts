import { getSession } from "@/lib/session";
import { getExportRows, getTags } from "@/lib/data";
import { exportFilename, filterRows, sanitizeScope } from "@/lib/export/format";
import { buildWorkbookBuffer } from "@/lib/export/xlsx";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit(`xlsx:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const sp = new URL(request.url).searchParams;
  // Raw scope hints from the query string (library "Export these" deep link);
  // sanitizeScope validates everything against the actual library before use,
  // same as the export panel's client-side path.
  const rawScope: Record<string, unknown> = {
    type: sp.get("type") ?? undefined,
    status: sp.get("status") ?? undefined,
    tag: sp.get("tag") ?? undefined,
    genre: sp.get("genre") ?? undefined,
    language: sp.get("lang") ?? undefined,
    minRating: sp.get("min") ?? undefined,
    yearFrom: sp.get("from") ?? undefined,
    yearTo: sp.get("to") ?? undefined,
    favoritesOnly: sp.get("fav") ?? undefined,
  };

  try {
    const [rows, tags] = await Promise.all([
      getExportRows(session.user.id),
      getTags(session.user.id),
    ]);
    const scope = sanitizeScope(rawScope, rows, tags.map((t) => t.name));
    const filtered = filterRows(rows, scope);
    const buf = await buildWorkbookBuffer(filtered);
    const filename = exportFilename(scope, "xlsx", "library");

    // Cast: Node/Next Response accepts a Uint8Array body at runtime; the DOM
    // BodyInit type is stricter about the ArrayBuffer generic.
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (err) {
    console.error("XLSX export failed:", err);
    return new Response("Export failed. Please try again.", {
      status: 500,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
}
