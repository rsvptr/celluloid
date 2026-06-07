import { getSession } from "@/lib/session";
import { parseUploadedList } from "@/lib/import/parse-upload";
import { importParsedTitles } from "@/lib/import/run-import";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_ROWS = 250; // bound per-upload work to stay within the function timeout
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB — reject before buffering to avoid OOM

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`import:${session.user.id}`, 5, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

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

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { titles, error } = await parseUploadedList(buf, file.name);
    if (error) return Response.json({ error }, { status: 400 });
    if (titles.length === 0) {
      return Response.json({ error: "No titles found in the file." }, { status: 400 });
    }

    const truncated = titles.length > MAX_ROWS;
    const rows = truncated ? titles.slice(0, MAX_ROWS) : titles;

    const result = await importParsedTitles({
      userId: session.user.id,
      parsed: rows,
    });

    return Response.json({ ...result, truncated, totalInFile: titles.length });
  } catch {
    return Response.json(
      { error: "Something went wrong importing that file. Please try again." },
      { status: 500 },
    );
  }
}
