import { getSession } from "@/lib/session";
import { generateRecommendations, type RecommendBasis } from "@/lib/recommend";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

/** Validate the optional recommendation basis; unknown shapes fall back to the whole library. */
function parseBasis(raw: unknown): RecommendBasis | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const b = raw as Record<string, unknown>;
  if (b.mode === "recent") {
    const n = typeof b.recentCount === "number" ? b.recentCount : 20;
    return { mode: "recent", recentCount: n };
  }
  if (b.mode === "pick") {
    const ids = Array.isArray(b.ids)
      ? b.ids.filter((x): x is string => typeof x === "string").slice(0, 200)
      : [];
    return { mode: "pick", ids };
  }
  return undefined;
}

export const runtime = "nodejs";
export const maxDuration = 60; // Claude + TMDB enrichment can take a while

export async function POST(request: Request) {
  const session = await getSession();
  if (!session?.user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = rateLimit(`rec:${session.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfter);

  let body: {
    count?: unknown;
    type?: unknown;
    focus?: unknown;
    model?: unknown;
    basis?: unknown;
    exclude?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }

  const exclude = Array.isArray(body.exclude)
    ? body.exclude.filter((x): x is string => typeof x === "string").slice(0, 100)
    : undefined;

  const result = await generateRecommendations(session.user.id, {
    count: typeof body.count === "number" ? body.count : undefined,
    type: body.type === "movie" || body.type === "tv" ? body.type : "all",
    // Bound the free-text focus so it can't bloat the prompt / token spend.
    focus: typeof body.focus === "string" ? body.focus.slice(0, 280) : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    basis: parseBasis(body.basis),
    exclude,
  });

  return Response.json(result);
}
