import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { getIp } from "better-auth/api";
import { prisma } from "@/lib/prisma";

/**
 * The auth audit trail (BA-15): sign-ins, sign-outs and security changes, kept
 * in the AuthEvent table so the record survives the password change or "Sign
 * out everywhere else" that deletes the session rows. src/lib/auth.ts decides
 * what happened; this module stores it.
 *
 * Every event an enabled endpoint can produce. The column is a plain string,
 * and this list is what validates it.
 */
export const AUTH_EVENT_TYPES = [
  "sign_in",
  "sign_out",
  "password_changed",
  "two_factor_enabled",
  "two_factor_disabled",
  "two_factor_secret_replaced",
  "backup_codes_regenerated",
  "session_revoked",
  "other_sessions_revoked",
] as const;

export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/** Enough of a user agent to name the browser and system. */
export const USER_AGENT_MAX_LENGTH = 200;

/**
 * What an event reads from a Better Auth endpoint context: the request headers,
 * and the auth options that say how to find the client IP. Nothing else, so an
 * event can't pick up the user's email.
 */
export interface AuthEventRequest {
  headers?: Headers;
  request?: Request;
  context: { options: BetterAuthOptions };
}

/**
 * Stores one event. Never throws: it runs inside sign-in, sign-out and password
 * changes, and a lost audit row must not fail them. A failure is logged with
 * the user id, never the email.
 */
export async function recordAuthEvent(
  userId: string,
  type: AuthEventType,
  request: AuthEventRequest | null,
): Promise<void> {
  try {
    const headers = request?.headers ?? request?.request?.headers;
    await prisma.authEvent.create({
      data: {
        userId,
        type,
        // The same resolution Better Auth uses for a session's IP, so Account
        // activity and Devices agree.
        ipAddress: headers && request ? getIp(headers, request.context.options) : null,
        userAgent: headers?.get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) || null,
      },
    });
  } catch (error) {
    console.error(
      `Could not record the ${type} auth event for user ${userId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}
