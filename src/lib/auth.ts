import "server-only";
import { betterAuth, type GenericEndpointContext } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins/two-factor";
import { recordAuthEvent, type AuthEventType } from "@/lib/auth-events";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { consumeSignupInvite } from "@/lib/signup-invite";

const trustedOrigins = [
  env.BETTER_AUTH_URL,
  env.NEXT_PUBLIC_SITE_URL,
  // Only trust localhost during development; in production it would widen the
  // origin allowlist for no reason.
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
].filter((v): v is string => Boolean(v));

export const signupsDisabled = !env.SIGNUP_INVITE_CODE;

// Better Auth authorizes these 2FA changes from the 60-second cookie cache, so
// for up to a minute a revoked session that knows the password could still
// replace the TOTP secret or the backup codes, and verify-totp, while 2FA is
// being turned on, would mint it a new session. The hook makes their session
// lookup read the row, as Better Auth already does for delete-user,
// change-password, revoke-session, revoke-other-sessions and two-factor/disable.
// A verify-totp during sign-in has no session cookie, so nothing changes there.
const databaseSessionPaths = new Set([
  "/two-factor/enable",
  "/two-factor/generate-backup-codes",
  "/two-factor/verify-totp",
]);

const enforceAuthRequestPolicy = createAuthMiddleware(async (context) => {
  if (databaseSessionPaths.has(context.path)) {
    return { context: { query: { ...context.query, disableCookieCache: true } } };
  }
  if (context.path === "/delete-user") {
    const body = context.body as Record<string, unknown> | undefined;
    if (typeof body?.password !== "string" || body.password.length === 0) {
      throw new APIError("BAD_REQUEST", {
        message: "Enter your current password to delete your account.",
      });
    }
    return;
  }
  if (context.path !== "/sign-up/email") return;

  const body = context.body as Record<string, unknown> | undefined;
  if (!consumeSignupInvite(body, env.SIGNUP_INVITE_CODE)) {
    throw new APIError("FORBIDDEN", {
      message: "That invite code wasn't accepted. Ask the person who invited you for a new one.",
    });
  }

  // Sign-up is the other way a name reaches the user row, so hold it to
  // updateProfile's rules (a string of at most 2,000 characters, trimmed and
  // cut to 80, not empty), and drop `image`, which Celluloid never sets.
  // Better Auth validates and reads this same body object after the hook.
  if (!body || typeof body.name !== "string" || body.name.length > 2000) {
    throw new APIError("BAD_REQUEST", { message: "Invalid request. Refresh and try again." });
  }
  const name = body.name.trim().slice(0, 80);
  if (!name) throw new APIError("BAD_REQUEST", { message: "Name can't be empty." });
  body.name = name;
  delete body.image;
});

// Auth audit trail (BA-15). recordAuthEvent never throws, so a lost row can't
// fail the sign-in, sign-out or change it describes.

// The endpoints whose new session is a sign-in (sign-up signs in too).
const signInPaths = new Set([
  "/sign-in/email",
  "/sign-up/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

/**
 * Whether a new session is a sign-in. Two kinds of new session aren't:
 * - A signed-in request replacing its own session (`context.session` is set).
 *   Turning 2FA on does this through verify-totp.
 * - The password step for an account with 2FA. The plugin's after hook deletes
 *   that session and clears `newSession`, and the verified code then creates
 *   the real one. Over HTTP, Better Auth runs this hook only after the
 *   request's after hooks (runWithAdapter, better-auth auth/base.mjs), so
 *   `newSession` is final here. tests/auth-events.test.ts pins that order.
 */
function isSignIn(session: { token: string }, context: GenericEndpointContext | null): boolean {
  return (
    !!context &&
    signInPaths.has(context.path) &&
    !context.context.session &&
    context.context.newSession?.session.token === session.token
  );
}

// Sign-out never loads the session, so the deleted row is where its user is.
// Revoking uses the deleted row too: the endpoint reports success even when
// the token matched nothing.
const sessionEndEvents = new Map<string, AuthEventType>([
  ["/sign-out", "sign_out"],
  ["/revoke-session", "session_revoked"],
]);

/**
 * A signed-in user's security changes, recorded once the endpoint has
 * succeeded. After hooks run for failures too, with the APIError as
 * `returned`.
 */
const recordAccountChange = createAuthMiddleware(async (ctx) => {
  const session = ctx.context.session;
  if (!session || isAPIError(ctx.context.returned)) return;
  let type: AuthEventType | null = null;
  switch (ctx.path) {
    case "/change-password":
      type = "password_changed";
      break;
    case "/two-factor/verify-totp":
      // The setup's confirming code. Only the one that turns 2FA on replaces
      // this device's session, which sets newSession.
      type = ctx.context.newSession ? "two_factor_enabled" : null;
      break;
    case "/two-factor/enable":
      // Starting setup changes nothing yet, but with 2FA already on this
      // replaces the authenticator key and the backup codes at once. The UI
      // never does that; a stolen session and password could.
      type = session.user.twoFactorEnabled ? "two_factor_secret_replaced" : null;
      break;
    case "/two-factor/disable":
      type = "two_factor_disabled";
      break;
    case "/two-factor/generate-backup-codes":
      type = "backup_codes_regenerated";
      break;
    case "/revoke-other-sessions":
      type = "other_sessions_revoked";
      break;
  }
  if (type) await recordAuthEvent(session.user.id, type, ctx);
});

export const auth = betterAuth({
  appName: "Celluloid",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // Profile names have one validated write path (`updateProfile`). The server
  // action still calls auth.api.updateUser internally so Better Auth refreshes
  // the session cookie, while the public HTTP endpoint stays unavailable.
  // Nothing calls /verify-password or /two-factor/get-totp-uri (turning 2FA on
  // returns the TOTP URI itself), and both check the password, so a stolen
  // session gets two fewer places to guess it. Disabled paths answer 404 over
  // HTTP before the rate limiter runs; auth.api calls still reach them.
  disabledPaths: ["/update-user", "/verify-password", "/two-factor/get-totp-uri"],

  emailAndPassword: {
    enabled: true,
    disableSignUp: signupsDisabled,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  hooks: { before: enforceAuthRequestPolicy, after: recordAccountChange },

  databaseHooks: {
    session: {
      create: {
        async after(session, context) {
          if (isSignIn(session, context)) await recordAuthEvent(session.userId, "sign_in", context);
        },
      },
      delete: {
        async after(session, context) {
          const type = context ? sessionEndEvents.get(context.path) : undefined;
          if (type) await recordAuthEvent(session.userId, type, context);
        },
      },
    },
  },

  user: {
    // The before hook requires a password even for a fresh session; Better Auth
    // then verifies it before deletion. App data cascades from the user row.
    deleteUser: { enabled: true },
  },

  // Brute-force damping on the credential endpoints. Persisted in Postgres
  // (the `rateLimit` table) rather than per-instance memory, so the tight
  // per-endpoint caps below hold across Vercel's serverless instances instead
  // of being silently multiplied by however many happen to be warm — the one
  // gap the in-memory default leaves open on the app's most sensitive routes.
  // Counters are short-lived (one `window` each) and self-expire; nothing reads
  // the table outside this limiter.
  rateLimit: {
    enabled: true,
    storage: "database",
    modelName: "rateLimit",
    window: 60,
    max: 100,
    // Every enabled endpoint that checks a password or a 2FA code gets a tight
    // per-IP budget: a stolen session could otherwise guess the password there
    // at the global 100/min, or 18/min on the plugin's 3-per-10s /two-factor/*
    // default. Keep windows at 60 s: Better Auth prunes rows idle
    // longer than its own longest window (60 s) and ignores these rules when it
    // does, so a longer window would reset early.
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/change-password": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 10 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
      "/delete-user": { window: 60, max: 5 },
      "/two-factor/enable": { window: 60, max: 5 },
      "/two-factor/disable": { window: 60, max: 5 },
      "/two-factor/generate-backup-codes": { window: 60, max: 5 },
      "/two-factor/verify-otp": { window: 60, max: 5 },
      // `false` skips the limiter entirely. The endpoint takes no guessable
      // input (the token sits in an HMAC-signed cookie) and returns early
      // without one, so a limiter write (several Postgres round trips) costs
      // more than the request it would guard.
      "/get-session": false,
    },
  },

  trustedOrigins,

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh daily
    // Short cache: still skips a DB hit on bursts of navigation, but a revoked
    // session dies within a minute instead of five.
    cookieCache: { enabled: true, maxAge: 60 },
  },

  plugins: [twoFactor(), nextCookies()], // nextCookies must be last
});

export type Session = typeof auth.$Infer.Session;
