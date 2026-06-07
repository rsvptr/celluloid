import { getSession } from "@/lib/session";
import { getExportRows } from "@/lib/data";
import { filterRows, type ExportScope } from "@/lib/export/format";
import { buildWorkbookBuffer } from "@/lib/export/xlsx";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const sp = new URL(request.url).searchParams;
  const scope: ExportScope = {
    type: (sp.get("type") as ExportScope["type"]) || "all",
    status: (sp.get("status") as ExportScope["status"]) || "all",
    favoritesOnly: sp.get("fav") === "1",
    tag: sp.get("tag") || null,
  };

  const rows = filterRows(await getExportRows(session.user.id), scope);
  const buf = await buildWorkbookBuffer(rows);

  // Cast: Node/Next Response accepts a Uint8Array body at runtime; the DOM
  // BodyInit type is stricter about the ArrayBuffer generic.
  return new Response(buf as unknown as BodyInit, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="celluloid-library.xlsx"',
    },
  });
}
