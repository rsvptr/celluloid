import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getTitleIndex } from "@/lib/data";

// Lightweight, always-fresh title list for the command palette (⌘K).
export async function GET() {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ titles: [] }, { status: 401 });
  }
  const titles = await getTitleIndex(session.user.id);
  return NextResponse.json({ titles });
}
