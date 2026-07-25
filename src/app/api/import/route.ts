import { getSession } from "@/lib/session";
import { parseUploadedList, ROW_SCAN_BUFFER } from "@/lib/import/parse-upload";
import { IMPORT_STAGING_BUDGET_MS, stageParsedImport } from "@/lib/import-staging";
import { prisma } from "@/lib/prisma";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 250; // bound per-upload work to stay within the function timeout
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — reject before buffering to avoid OOM

export async function POST(request: Request) {
  // Matching is deadlined from here, not from where it starts, so the time this
  // request spends reading and parsing the file comes out of the same budget.
  const startedAt = Date.now();
  const session = await getSession();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`import:${session.user.id}`, 5, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  // Reject oversized uploads from the declared length BEFORE buffering the body
  // into memory (the file.size check below only runs after a full parse).
  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) {
    return Response.json(
      { error: "A valid Content-Length header is required for imports." },
      { status: 411 },
    );
  }
  const declared = Number(contentLength);
  if (!Number.isSafeInteger(declared) || declared <= 0) {
    return Response.json(
      { error: "A valid Content-Length header is required for imports." },
      { status: 411 },
    );
  }
  if (declared > MAX_BYTES + 64 * 1024) {
    return Response.json(
      { error: "That file is too large. Please upload a file under 2 MB." },
      { status: 413 },
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    if (f instanceof File) file = f;
  } catch {
    // fall through
  }
  if (!file) return Response.json({ error: "No file uploaded." }, { status: 400 });
  if (file.size > MAX_BYTES) {
    return Response.json(
      { error: "That file is too large. Please upload a file under 2 MB." },
      { status: 413 },
    );
  }

  let jobId: string | null = null;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const job = await prisma.importJob.create({
      data: {
        userId: session.user.id,
        filename: file.name.slice(0, 255),
        status: "PARSING",
      },
      select: { id: true },
    });
    jobId = job.id;
    // Pass the row ceiling so parsing stops early instead of materializing an
    // entire crafted-to-decompress-huge sheet before this route truncates it.
    const { titles, error, totalRows, scanCapped, notes } = await parseUploadedList(
      buf,
      file.name,
      MAX_ROWS,
    );
    if (error) {
      await prisma.importJob.update({
        where: { id: job.id },
        data: { status: "FAILED", summary: { error: "PARSE_FAILED" } },
      });
      return Response.json({ error }, { status: 400 });
    }
    if (titles.length === 0) {
      await prisma.importJob.update({
        where: { id: job.id },
        data: { status: "FAILED", summary: { error: "NO_TITLES" } },
      });
      return Response.json({ error: "No titles found in the file." }, { status: 400 });
    }

    const truncated = titles.length > MAX_ROWS;
    const rows = truncated ? titles.slice(0, MAX_ROWS) : titles;
    // totalRows is exact unless parsing hit the bounded scan ceiling.
    const totalInFile = totalRows ?? MAX_ROWS + ROW_SCAN_BUFFER;
    const totalInFileExact = !scanCapped;

    const staged = await stageParsedImport({
      userId: session.user.id,
      jobId: job.id,
      parsed: rows,
      deadlineAt: startedAt + IMPORT_STAGING_BUDGET_MS,
      summary: {
        parsed: rows.length,
        truncated,
        totalInFile,
        totalInFileExact,
        // What the parser had to INFER rather than read: which column it treated
        // as a viewing date, whether a rating scale could be determined, and so
        // on. A spreadsheet cannot state its own conventions, so these guesses
        // decide real personal data — a Letterboxd watchlist and its watched
        // export are header-identical, and reading one as the other would invent
        // a watch history. Carrying the notes to the review screen is what makes
        // a wrong guess correctable before anything is committed.
        ...(notes && notes.length > 0 ? { notes } : {}),
      },
    });

    return Response.json({ job: staged }, { status: 201 });
  } catch (error) {
    console.error("Staged import setup failed:", error);
    if (jobId) {
      await prisma.importJob
        .updateMany({
          where: { id: jobId, userId: session.user.id, status: "PARSING" },
          data: { status: "FAILED", summary: { error: "STAGING_FAILED" } },
        })
        .catch(() => {});
    }
    return Response.json(
      { error: "Something went wrong importing that file. Please try again." },
      { status: 500 },
    );
  }
}
