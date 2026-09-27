import { z } from "zod";
import {
  analyzeBackupRestore,
  createRestoreConfirmation,
  restoreBackup,
  verifyRestoreConfirmation,
} from "@/lib/backup";
import {
  backupInputSchema,
  MAX_BACKUP_BYTES,
  type RestoreMode,
} from "@/lib/backup-format";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSession } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

const restoreModeSchema = z.enum(["merge", "replace-personal"]);

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function POST(request: Request) {
  const session = await getSession({ skipCookieCache: true });
  if (!session?.user) return json({ error: "Unauthorized" }, 401);

  const limited = rateLimit(`backup-restore:${session.user.id}`, 8, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) {
    return json({ error: "A valid Content-Length header is required for backup restores." }, 411);
  }

  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    return json({ error: "A valid Content-Length header is required for backup restores." }, 411);
  }
  if (declared > MAX_BACKUP_BYTES + 128 * 1024) {
    return json({ error: "That backup is larger than 4 MB." }, 413);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Celluloid couldn't read that upload. Choose the JSON backup again." }, 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "Choose a backup file first." }, 400);
  if (file.size > MAX_BACKUP_BYTES) {
    return json({ error: "That backup is larger than 4 MB." }, 413);
  }

  const modeResult = restoreModeSchema.safeParse(form.get("mode"));
  if (!modeResult.success) return json({ error: "Choose a valid restore mode." }, 400);
  const mode: RestoreMode = modeResult.data;
  const dryRun = form.get("dryRun") === "true";

  let bytes: Uint8Array;
  let raw: unknown;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    return json({ error: "That file isn't valid UTF-8 JSON." }, 400);
  }

  const parsed = backupInputSchema.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        error: "That file isn't a valid Celluloid v1 or v2 backup.",
        issues: parsed.error.issues.slice(0, 20).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      400,
    );
  }

  try {
    const plan = await analyzeBackupRestore(session.user.id, parsed.data, mode);
    if (dryRun) {
      return json({
        ...plan.counts,
        confirmationToken: createRestoreConfirmation(
          session.user.id,
          mode,
          bytes,
          plan.counts,
          plan.stateDigest,
        ),
      });
    }

    const confirmationToken = form.get("confirmationToken");
    if (
      typeof confirmationToken !== "string" ||
      !verifyRestoreConfirmation(
        confirmationToken,
        session.user.id,
        mode,
        bytes,
        plan.counts,
        plan.stateDigest,
      )
    ) {
      return json(
        { error: "The restore preview expired or the library changed. Preview the backup again." },
        409,
      );
    }

    return json(await restoreBackup(session.user.id, parsed.data, mode, plan));
  } catch (error) {
    console.error("Backup restore failed:", error);
    return json(
      {
        error:
          "Celluloid couldn't finish the restore. Some batches may have completed, so refresh and inspect your library before retrying.",
      },
      500,
    );
  }
}
