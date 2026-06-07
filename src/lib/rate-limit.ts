// Best-effort in-memory fixed-window rate limiter. Note: state is per server
// instance, so on a multi-instance/serverless deploy it only bounds bursts
// within a single instance. For durable limits, back this with Upstash/Vercel KV.

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { ok: boolean; retryAfter: number } {
  const now = Date.now();
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
