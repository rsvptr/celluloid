import { createBackupEnvelope } from "@/lib/backup";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(`backup:${session.user.id}`, 10, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  try {
    const backup = await createBackupEnvelope(session.user.id);
    const encoded = new TextEncoder().encode(`${JSON.stringify(backup, null, 2)}\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const stamp = backup.exportedAt.replace(/[:.]/g, "-");

    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="celluloid-backup-${stamp}.json"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Backup export failed:", error);
    return Response.json(
      { error: "Celluloid couldn't create the backup. Try again." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
