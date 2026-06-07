import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/crypto";

/**
 * Resolve the Anthropic API key for a user: their own encrypted key if set,
 * otherwise the deployment-default ANTHROPIC_API_KEY. Returns null if neither.
 */
export async function resolveAnthropicKey(userId: string): Promise<string | null> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { anthropicKeyEnc: true },
  });
  if (u?.anthropicKeyEnc) {
    try {
      return decryptSecret(u.anthropicKeyEnc);
    } catch (e) {
      // Leave a server-side trail (a stored key that won't decrypt usually means
      // ENCRYPTION_KEY changed) before falling back to the server default.
      console.error(`Failed to decrypt stored Anthropic key for user ${userId}:`, e);
    }
  }
  return process.env.ANTHROPIC_API_KEY || null;
}

export function anthropicClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey });
}
