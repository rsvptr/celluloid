import { getSession } from "@/lib/session";
import { getExportRows } from "@/lib/data";
import { exportFilename, filterRows, type ExportScope } from "@/lib/export/format";
import { buildWorkbookBuffer } from "@/lib/export/xlsx";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const rl = rateLimit(`xlsx:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const sp = new URL(request.url).searchParams;
  const minRaw = Number(sp.get("min"));
  const intIn = (raw: string | null, lo: number, hi: number): number | null => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : null;
  };
  const typeRaw = sp.get("type");
  const statusRaw = sp.get("status") ?? "";
  const validStatus = ["WATCHLIST", "WATCHING", "WATCHED", "ON_HOLD", "DROPPED"];
  const scope: ExportScope = {
    type: typeRaw === "movie" || typeRaw === "tv" ? typeRaw : "all",
    status: validStatus.includes(statusRaw)
      ? (statusRaw as ExportScope["status"])
      : "all",
    favoritesOnly: sp.get("fav") === "1",
    tag: sp.get("tag") || null,
    language: sp.get("lang") || null,
    genre: sp.get("genre") || null,
    minRating: Number.isFinite(minRaw) && minRaw > 0 ? minRaw : null,
    yearFrom: intIn(sp.get("from"), 1870, 2100),
    yearTo: intIn(sp.get("to"), 1870, 2100),
  };

  try {
    const rows = filterRows(await getExportRows(session.user.id), scope);
    const buf = await buildWorkbookBuffer(rows);
    const filename = exportFilename(scope, "xlsx", "library");

    // Cast: Node/Next Response accepts a Uint8Array body at runtime; the DOM
    // BodyInit type is stricter about the ArrayBuffer generic.
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("XLSX export failed:", err);
    return new Response("Export failed. Please try again.", { status: 500 });
  }
}
