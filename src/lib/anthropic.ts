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
