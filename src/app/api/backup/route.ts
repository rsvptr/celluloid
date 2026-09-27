import { createBackupEnvelope } from "@/lib/backup";
import { MAX_BACKUP_BYTES } from "@/lib/backup-format";
import { prisma } from "@/lib/prisma";
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
    // Backups are machine-restored artifacts. Compact JSON buys substantially
    // more headroom under the restore route's fixed serverless body limit.
    const encoded = new TextEncoder().encode(JSON.stringify(backup));
    if (encoded.byteLength > MAX_BACKUP_BYTES) {
      return Response.json(
        {
          error:
            "This backup is larger than the 4 MB restore limit, so Celluloid stopped the download instead of creating a file it can't restore.",
        },
        {
          status: 413,
          headers: { "Cache-Control": "private, no-store" },
        },
      );
    }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const stamp = backup.exportedAt.replace(/[:.]/g, "-");

    // Record when the owner last took a copy, so Settings can say how stale the
    // off-site backup is instead of offering a button with no feedback at all.
    // Stamped once the envelope is built and about to stream: whether the file
    // reached disk is not observable here, and a stamp that is occasionally a
    // few seconds optimistic is far better than the freshness signal being
    // absent. A failure to record must not cost the owner the backup itself, so
    // it is logged and swallowed.
    try {
      await prisma.user.update({
        where: { id: session.user.id },
        data: { lastBackupAt: new Date() },
      });
    } catch (stampError) {
      console.error("Backup export: could not record lastBackupAt:", stampError);
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(encoded.byteLength),
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
