import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { searchMulti } from "@/lib/tmdb";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export interface SearchResult {
  tmdbId: number;
  mediaType: "movie" | "tv";
  name: string;
  originalName: string | null;
  year: string;
  posterPath: string | null;
  overview: string;
  tmdbRating: number | null;
  language: string | null;
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`search:${session.user.id}`, 60, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ results: [] });

  try {
    const items = await searchMulti(q);
    const results: SearchResult[] = items.map((it) => ({
      tmdbId: it.id,
      mediaType: it.media_type,
      name: it.title ?? it.name ?? "Untitled",
      originalName: it.original_title ?? it.original_name ?? null,
      year: (it.release_date ?? it.first_air_date ?? "").slice(0, 4),
      posterPath: it.poster_path ?? null,
      overview: it.overview ?? "",
      tmdbRating: it.vote_average ?? null,
      language: it.original_language ?? null,
    }));
    return NextResponse.json({ results });
  } catch (err) {
    console.error("TMDB search failed:", err);
    return NextResponse.json(
      { error: "Search is temporarily unavailable. Please try again." },
      { status: 502 },
    );
  }
}
