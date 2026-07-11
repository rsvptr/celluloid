import { getSession } from "@/lib/session";
import {
  runRecommendationStream,
  type RecommendBasis,
  type RecStreamEvent,
} from "@/lib/recommend";
import { isRecEra } from "@/lib/models";
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

/**
 * Streams recommendations as NDJSON (one RecStreamEvent per line) so results
 * appear the moment Claude produces them, instead of after the whole batch.
 */
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
    language?: unknown;
    genre?: unknown;
    era?: unknown;
  } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }

  const exclude = Array.isArray(body.exclude)
    ? body.exclude
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.slice(0, 200)) // bound each entry, not just the count
        .slice(0, 100)
    : undefined;

  const opts = {
    count: typeof body.count === "number" ? body.count : undefined,
    type: (body.type === "movie" || body.type === "tv" ? body.type : "all") as
      | "movie"
      | "tv"
      | "all",
    // Bound the free-text focus so it can't bloat the prompt / token spend.
    focus: typeof body.focus === "string" ? body.focus.slice(0, 280) : undefined,
    model: typeof body.model === "string" ? body.model : undefined,
    basis: parseBasis(body.basis),
    exclude,
    // Short, bounded preference hints (language is an ISO code; genre a name).
    language:
      typeof body.language === "string" && body.language
        ? body.language.slice(0, 12)
        : undefined,
    genre:
      typeof body.genre === "string" && body.genre
        ? body.genre.slice(0, 40)
        : undefined,
    era: typeof body.era === "string" && isRecEra(body.era) ? body.era : undefined,
  };

  const encoder = new TextEncoder();
  const userId = session.user.id;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: RecStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // Controller already closed (client went away) — nothing to do.
        }
      };
      try {
        await runRecommendationStream(userId, opts, emit, request.signal);
      } catch (err) {
        console.error("Recommendation stream crashed:", err);
        emit({ type: "error", error: "Something went wrong. Please try again." });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
    cancel() {
      // Reader cancelled; runRecommendationStream also observes request.signal.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Tell proxies not to buffer — results must reach the client as produced.
      "X-Accel-Buffering": "no",
    },
  });
}
