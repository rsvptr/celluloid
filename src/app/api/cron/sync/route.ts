import { timingSafeEqual } from "node:crypto";
import { runScheduledSync } from "@/lib/metadata-sync";

export const runtime = "nodejs";

/**
 * 60s is the ceiling every Vercel plan allows without configuration, so the
 * schedule keeps working wherever this is deployed. The run stays inside it by
 * refusing to START another title once RUN_BUDGET_MS has elapsed rather than by
 * hoping ~50 TMDB round trips finish in time; whatever is left keeps its place
 * at the head of the queue and goes first tomorrow.
 */
export const maxDuration = 60;

/** Leaves ~10s of headroom for the titles already in flight to commit. */
const RUN_BUDGET_MS = 45_000;

// The response depends on an Authorization header, and a cached one would let
// a single authorized call be replayed to anyone. Stated rather than inferred.
export const dynamic = "force-dynamic";

/**
 * Constant-time comparison of the Vercel Cron bearer token.
 *
 * timingSafeEqual throws on a length mismatch, so lengths are checked first;
 * that leaks the secret's length and nothing else. An absent CRON_SECRET is a
 * refusal, never a pass — an endpoint that mutates the whole library on an
 * unauthenticated GET is not something to fall back to.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set — refusing to run the scheduled sync.");
    return false;
  }
  const provided = request.headers.get("authorization");
  if (!provided) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/**
 * Daily TMDB metadata refresh (see vercel.json for the schedule).
 *
 * Vercel Cron issues a plain GET with `Authorization: Bearer $CRON_SECRET` and
 * carries no session, so the run resolves its users directly. It takes no
 * caller input at all — no query parameters, no body — which is deliberate:
 * the only thing this endpoint reads from the request is the credential above,
 * so there is no argument surface to validate or to abuse.
 */
export async function GET(request: Request) {
  if (!isAuthorizedCron(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const result = await runScheduledSync({ deadline: Date.now() + RUN_BUDGET_MS });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Scheduled metadata sync failed:", error);
    return Response.json(
      { error: "Scheduled metadata sync failed." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
