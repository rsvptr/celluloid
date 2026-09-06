import "server-only";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
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

const enforceAuthRequestPolicy = createAuthMiddleware(async (context) => {
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
});

export const auth = betterAuth({
  appName: "Celluloid",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  // Profile names have one validated write path (`updateProfile`). The server
  // action still calls auth.api.updateUser internally so Better Auth refreshes
  // the session cookie, while the public HTTP endpoint stays unavailable.
  disabledPaths: ["/update-user"],

  emailAndPassword: {
    enabled: true,
    disableSignUp: signupsDisabled,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  hooks: { before: enforceAuthRequestPolicy },

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
    customRules: {
      "/sign-in/email": { window: 60, max: 10 },
      "/sign-up/email": { window: 60, max: 5 },
      "/change-password": { window: 60, max: 5 },
      "/two-factor/verify-totp": { window: 60, max: 10 },
      "/two-factor/verify-backup-code": { window: 60, max: 5 },
      "/delete-user": { window: 60, max: 5 },
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
