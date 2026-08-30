import { createHash, timingSafeEqual } from "node:crypto";

function digestInviteCode(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compare invite codes without leaking their shared-prefix length through timing. */
export function matchesSignupInvite(
  provided: unknown,
  expected: string | undefined,
): boolean {
  if (typeof provided !== "string" || !expected) return false;
  return timingSafeEqual(digestInviteCode(provided), digestInviteCode(expected));
}

/** Validate and consume the request-only field so it cannot reach user persistence. */
export function consumeSignupInvite(
  body: Record<string, unknown> | undefined,
  expected: string | undefined,
): boolean {
  if (!matchesSignupInvite(body?.inviteCode, expected)) return false;
  delete body?.inviteCode;
  return true;
}
