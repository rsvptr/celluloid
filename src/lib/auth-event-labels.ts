import type { AuthEventType } from "@/lib/auth-events";

/**
 * What Settings' Account activity calls each auth event. A module of its own
 * because auth-events.ts is server-only; the type import is erased.
 */
const AUTH_EVENT_LABELS: Record<AuthEventType, string> = {
  sign_in: "Signed in",
  sign_out: "Signed out",
  password_changed: "Changed password",
  two_factor_enabled: "Turned on 2FA",
  two_factor_disabled: "Turned off 2FA",
  two_factor_secret_replaced: "Replaced the 2FA key and backup codes",
  backup_codes_regenerated: "Made new backup codes",
  session_revoked: "Signed out a device",
  other_sessions_revoked: "Signed out everywhere else",
  all_sessions_revoked: "Signed out everywhere",
};

/** The label for a stored event type. A type this build doesn't know gets a generic one. */
export function authEventLabel(type: string): string {
  return Object.hasOwn(AUTH_EVENT_LABELS, type)
    ? AUTH_EVENT_LABELS[type as AuthEventType]
    : "Account change";
}
