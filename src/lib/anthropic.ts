import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";

/** Outcome of resolving a user's Anthropic key, enough to distinguish a normal
 * "no user key, use the default" from "user has a key but it wouldn't decrypt". */
export interface ResolvedAnthropicKey {
  /** The key to use, or null when neither a user key nor a server default exists. */
  key: string | null;
  /** True when `key` is the deployment default rather than the user's own key. */
  usedFallback: boolean;
  /** True when the user had a stored key (even if it failed to decrypt). */
  hadUserKey: boolean;
}

const MAX_POSTGRES_INT = 2_147_483_647;

export function parseSharedAiDailyRunLimit(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^\d+$/.test(value)) {
    throw new Error("SHARED_AI_DAILY_RUN_LIMIT must be a positive whole number.");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_POSTGRES_INT) {
    throw new Error(
      `SHARED_AI_DAILY_RUN_LIMIT must be between 1 and ${MAX_POSTGRES_INT}.`,
    );
  }
  return limit;
}

export function sharedAiUtcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type SharedAiRunReserver = (day: string, limit: number) => Promise<number | null>;

async function reserveSharedAiRunInDatabase(
  day: string,
  limit: number,
): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ runCount: number }>>`
    INSERT INTO "SharedAiDailyUsage" ("day", "runCount")
    VALUES (${day}::date, 1)
    ON CONFLICT ("day") DO UPDATE
    SET "runCount" = "SharedAiDailyUsage"."runCount" + 1
    WHERE "SharedAiDailyUsage"."runCount" < ${limit}
    RETURNING "runCount"
  `;
  return rows[0]?.runCount ?? null;
}

export interface SharedAiRunReservation {
  allowed: boolean;
  day: string | null;
  limit: number | null;
  runCount: number | null;
}

/**
 * Atomically claim one shared-key run for the current UTC day. A blank limit
 * preserves the existing uncapped behavior and never touches the counter.
 */
export async function reserveSharedAiRun(
  rawLimit = process.env.SHARED_AI_DAILY_RUN_LIMIT,
  now = new Date(),
  reserve: SharedAiRunReserver = reserveSharedAiRunInDatabase,
): Promise<SharedAiRunReservation> {
  const limit = parseSharedAiDailyRunLimit(rawLimit);
  if (limit === null) {
    return { allowed: true, day: null, limit: null, runCount: null };
  }

  const day = sharedAiUtcDay(now);
  const runCount = await reserve(day, limit);
  return { allowed: runCount !== null, day, limit, runCount };
}

/**
 * Resolve the Anthropic API key for a user: their own encrypted key if set,
 * otherwise the deployment-default ANTHROPIC_API_KEY. `usedFallback` tells the
 * caller the returned key is the default; combined with `hadUserKey` it can tell
 * "user has no key" (normal) from "user key present but undecryptable" (worth a
 * warning). `key` is null when neither source is available.
 */
export async function resolveAnthropicKey(userId: string): Promise<ResolvedAnthropicKey> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { anthropicKeyEnc: true },
  });
  const hadUserKey = !!u?.anthropicKeyEnc;
  if (u?.anthropicKeyEnc) {
    try {
      return { key: decryptSecret(u.anthropicKeyEnc), usedFallback: false, hadUserKey };
    } catch (e) {
      // Leave a server-side trail (a stored key that won't decrypt usually means
      // ENCRYPTION_KEY changed) before falling back to the server default.
      console.error(`Failed to decrypt stored Anthropic key for user ${userId}:`, e);
    }
  }
  return { key: process.env.ANTHROPIC_API_KEY || null, usedFallback: true, hadUserKey };
}

export function anthropicClient(apiKey: string): Anthropic {
  // A server-side ceiling independent of any caller signal: the recommend
  // route runs under a 60s function limit, and the SDK's own default timeout
  // (10 minutes) would let a stalled upstream ride straight into platform
  // termination with no terminal NDJSON line ever reaching the client. Callers
  // still abort earlier through their own signals; this is the backstop for
  // any path where no signal is threaded.
  return new Anthropic({ apiKey, timeout: 55_000 });
}

/**
 * Map an Anthropic SDK error to a message a person can act on, using the SDK's
 * typed error classes (never string-matching). Falls back to the raw message.
 */
export function friendlyAnthropicError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return "Your Anthropic API key was rejected. Check it in Settings (it may have been revoked).";
  }
  if (e instanceof Anthropic.PermissionDeniedError) {
    return "Your Anthropic API key doesn't have access to this model. Try another model, or check your plan.";
  }
  if (e instanceof Anthropic.RateLimitError) {
    return "Anthropic is rate-limiting your key right now. Wait a moment and try again.";
  }
  if (e instanceof Anthropic.NotFoundError) {
    return "That model isn't available to your API key. Pick a different model and try again.";
  }
  if (e instanceof Anthropic.InternalServerError) {
    return e.type === "overloaded_error"
      ? "Claude is briefly overloaded. Try again in a few seconds, or switch models."
      : "The Anthropic API hit a server error. Please try again.";
  }
  if (e instanceof Anthropic.APIConnectionError) {
    return "Couldn't reach the Anthropic API. Check your connection and try again.";
  }
  if (e instanceof Anthropic.APIError) {
    return `AI request failed: ${e.message}`;
  }
  // Unknown, non-SDK error: never surface its raw message (it can carry stack
  // internals or upstream response text). The caller logs the raw error
  // server-side (see recommend.ts), so a generic, actionable line is enough here.
  return "Claude request failed. Try again in a moment.";
}
