import { timingSafeEqual } from "node:crypto";
import { runScheduledSync, summarizeScheduledRun } from "@/lib/metadata-sync";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

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
 * Same floor lib/env.ts enforces for BETTER_AUTH_SECRET/ENCRYPTION_KEY
 * (MIN_SECRET_LENGTH there). A CRON_SECRET shorter than this is weak enough to
 * guess or brute-force, so it's treated as equivalent to no secret at all.
 */
const MIN_SECRET_LENGTH = 32;

/**
 * Constant-time comparison of the Vercel Cron bearer token.
 *
 * timingSafeEqual throws on a length mismatch, so lengths are checked first;
 * that leaks the secret's length and nothing else. An absent or too-short
 * CRON_SECRET is a refusal, never a pass — an endpoint that mutates the whole
 * library on an unauthenticated GET is not something to fall back to.
 */
function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("CRON_SECRET is not set — refusing to run the scheduled sync.");
    return false;
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error(
      `CRON_SECRET is shorter than ${MIN_SECRET_LENGTH} characters — refusing to run the scheduled sync.`,
    );
    return false;
  }
  const provided = request.headers.get("authorization");
  if (!provided) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const actual = Buffer.from(provided, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** First `x-forwarded-for` hop, or "unknown" if the request arrived without one. */
function clientIp(request: Request): string {
  const forwardedFor = request.headers.get("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || "unknown";
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
  // IP-keyed limiter so CRON_SECRET can't be brute-forced by hammering this
  // endpoint. rateLimit() checks and increments in a single call — there's no
  // way to "peek" the count without also consuming it — so consulting it here,
  // before the comparison, is the simplest approach that reliably counts every
  // failed guess. Tradeoff, deliberately accepted: a successful call sharing a
  // hot IP with recent failures (e.g. behind the same NAT/proxy) is also
  // blocked and has to wait out the window. A delayed scheduled run is cheap;
  // letting failed guesses go uncounted is not.
  const limited = rateLimit(`cron-auth:${clientIp(request)}`, 5, 60_000);
  if (!limited.ok) return tooManyRequests(limited.retryAfter);

  if (!isAuthorizedCron(request)) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: { "Cache-Control": "private, no-store" } },
    );
  }

  try {
    const result = await runScheduledSync({ deadline: Date.now() + RUN_BUDGET_MS });
    // A totally-failed run must not report 200 — see summarizeScheduledRun.
    const { totalFailure, degraded } = summarizeScheduledRun(result);
    return Response.json(
      { ...result, degraded },
      {
        status: totalFailure ? 502 : 200,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  } catch (error) {
    console.error("Scheduled metadata sync failed:", error);
    return Response.json(
      { error: "Scheduled metadata sync failed." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
