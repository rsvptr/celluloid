import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const trustedOrigins = [
  env.BETTER_AUTH_URL,
  env.NEXT_PUBLIC_SITE_URL,
  // Only trust localhost during development; in production it would widen the
  // origin allowlist for no reason.
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000"] : []),
].filter((v): v is string => Boolean(v));

/**
 * Public sign-ups are CLOSED by default. Set ALLOW_SIGNUPS=true to open them long
 * enough to create the owner account on first run, then remove the var to lock the
 * deployment back down.
 *
 * Back-compat (one release only): the previous flag was DISABLE_SIGNUPS, where
 * DISABLE_SIGNUPS=false meant "open". That single case is still honored and logged
 * once, server-side, so existing deployments keep working across the rename.
 */
const signupsAllowed =
  process.env.ALLOW_SIGNUPS === "true" || process.env.DISABLE_SIGNUPS === "false";

if (process.env.DISABLE_SIGNUPS === "false") {
  console.warn(
    "[celluloid] DISABLE_SIGNUPS is deprecated; rename it to ALLOW_SIGNUPS=true. The old variable will stop being honored in a future release.",
  );
}

export const signupsDisabled = !signupsAllowed;

export const auth = betterAuth({
  appName: "Celluloid",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: signupsDisabled,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  user: {
    // Lets the client call authClient.deleteUser({ password }); Better Auth
    // verifies the password before deleting, so a stolen session cookie alone
    // can't wipe the account. App data cascades from the user row.
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
