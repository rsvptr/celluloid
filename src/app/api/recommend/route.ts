import { getSession } from "@/lib/session";
import {
  runRecommendationStream,
  type RecStreamEvent,
} from "@/lib/recommend";
import { isRecEra, resolveRecModel } from "@/lib/models";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { z } from "zod";

const boundedId = z.string().min(1).max(64);
const recentCountSchema = z.union([z.literal(10), z.literal(20), z.literal(50)]);

// Every field below is already bounded, but that schema only runs after the
// full body has been read into memory — reject an oversized declared length
// up front instead. Mirrors the Content-Length pre-check in the backup
// restore route (411 for a missing/invalid header, 413 over the cap).
const MAX_BODY_BYTES = 64 * 1024;

export const recommendRequestSchema = z
  .object({
    count: z.number().int().min(1).max(30).optional(),
    type: z.enum(["all", "movie", "tv"]).default("all"),
    focus: z.string().trim().max(280).optional(),
    // A tab opened before the model lineup changed still sends the old id;
    // run it on the successor rather than failing the request.
    model: z.string().max(200).transform(resolveRecModel).optional(),
    basis: z
      .discriminatedUnion("mode", [
        z.object({ mode: z.literal("recent"), recentCount: recentCountSchema }),
        z.object({ mode: z.literal("pick"), ids: z.array(boundedId).max(200) }),
      ])
      .optional(),
    exclude: z
      .array(z.string().min(1).max(200))
      .transform((titles) => titles.slice(0, 100))
      .optional(),
    language: z
      .string()
      .trim()
      .min(2)
      .max(12)
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z]{2})?$/, "Invalid language code")
      .optional(),
    genre: z.string().trim().min(1).max(40).optional(),
    era: z.string().refine(isRecEra, "Unknown era").optional(),
  })
  .strict();

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

  const contentLength = request.headers.get("content-length");
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) {
    return Response.json(
      { error: "A valid Content-Length header is required for recommendation requests." },
      { status: 411 },
    );
  }
  const declaredLength = Number(contentLength);
  if (!Number.isSafeInteger(declaredLength) || declaredLength <= 0) {
    return Response.json(
      { error: "A valid Content-Length header is required for recommendation requests." },
      { status: 411 },
    );
  }
  if (declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "That request is too large." }, { status: 413 });
  }

  let rawBody: unknown = {};
  try {
    const text = await request.text();
    rawBody = text.trim() ? JSON.parse(text) : {};
  } catch {
    return Response.json(
      { error: "Invalid JSON request body." },
      { status: 400 },
    );
  }

  const parsed = recommendRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Invalid recommendation request.",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const body = parsed.data;
  const opts = {
    count: body.count,
    type: body.type,
    focus: body.focus || undefined,
    model: body.model,
    basis: body.basis,
    exclude: body.exclude,
    language: body.language,
    genre: body.genre,
    era: body.era,
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
      // The function dies at maxDuration (60s) with whatever bytes made it
      // out; the SDK alone would happily keep streaming past that. A 50s
      // server deadline leaves room for in-flight TMDB enrichment to settle
      // and for a terminal line to actually reach the client, so a slow run
      // ends with partial results and an explanation instead of a socket that
      // just stops.
      const deadline = AbortSignal.timeout(50_000);
      const signal = AbortSignal.any([request.signal, deadline]);
      try {
        await runRecommendationStream(userId, opts, emit, signal);
        if (deadline.aborted && !request.signal.aborted) {
          emit({
            type: "error",
            error:
              "This run hit the server's time limit. Anything already suggested is kept. Run it again for the rest, or ask for fewer titles.",
          });
        }
      } catch (err) {
        console.error("Recommendation stream crashed:", err);
        emit({ type: "error", error: "Recommendations failed to start. Try again in a moment." });
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
