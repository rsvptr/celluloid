// Best-effort in-memory fixed-window rate limiter. Note: state is per server
// instance, so on a multi-instance/serverless deploy it only bounds bursts
// within a single instance. For durable limits, back this with Upstash/Vercel KV
// (auth routes already use better-auth's database-backed limiter; per D-004
// this in-memory one deliberately stays for app routes).

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

/**
 * Expired windows used to accumulate forever: every distinct key (public share
 * slugs, per-IP counters) left a row in the Map for the life of the instance,
 * so unauthenticated traffic could grow it without bound. The sweep is
 * amortized — it only runs when the Map is at the cap — and if live entries
 * alone still exceed the cap, the ones closest to expiry are dropped: they are
 * the cheapest to lose, since their state was about to reset anyway.
 */
const MAX_WINDOWS = 10_000;

function sweep(now: number): void {
  for (const [key, w] of windows) {
    if (w.resetAt <= now) windows.delete(key);
  }
  const excess = windows.size - MAX_WINDOWS;
  if (excess <= 0) return;
  const byExpiry = [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (const [key] of byExpiry.slice(0, excess)) windows.delete(key);
}

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  if (windows.size >= MAX_WINDOWS) sweep(now);
  const w = windows.get(key);

  if (!w || w.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, retryAfter: 0 };
  }
  if (w.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((w.resetAt - now) / 1000) };
  }
  w.count += 1;
  return { ok: true, retryAfter: 0 };
}

/** 429 JSON response with a Retry-After header. */
export function tooManyRequests(retryAfter: number): Response {
  return Response.json(
    { error: "You're going a bit fast. Please try again in a moment." },
    { status: 429, headers: { "Retry-After": String(Math.max(1, retryAfter)) } },
  );
}
