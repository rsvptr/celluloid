import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getTitleIndex } from "@/lib/data";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

// Lightweight, always-fresh title list for the command palette (⌘K).
export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`titles:${session.user.id}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const titles = await getTitleIndex(session.user.id);
  return NextResponse.json(
    { titles },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
