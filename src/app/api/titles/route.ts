import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getTitleIndex } from "@/lib/data";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

// Lightweight, always-fresh title list for the command palette (⌘K). The
// palette revalidates it on every open by sending back the ETag it holds, so
// an unchanged index costs an empty 304 rather than the whole list (VE-14).
// Still no-store: the browser keeps no copy of the owner's library.
export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`titles:${session.user.id}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const titles = await getTitleIndex(session.user.id);
  const body = JSON.stringify({ titles });
  const headers = {
    "Cache-Control": "private, no-store",
    ETag: `W/"${createHash("sha256").update(body).digest("base64url")}"`,
  };
  if (request.headers.get("if-none-match") === headers.ETag) {
    return new NextResponse(null, { status: 304, headers });
  }
  return new NextResponse(body, {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
