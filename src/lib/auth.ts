import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { twoFactor } from "better-auth/plugins";
import { prisma } from "@/lib/prisma";

const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.NEXT_PUBLIC_SITE_URL,
  "http://localhost:3000",
].filter((v): v is string => Boolean(v));

/** Public sign-ups are open by default; set DISABLE_SIGNUPS=true to close them. */
export const signupsDisabled = process.env.DISABLE_SIGNUPS === "true";

export const auth = betterAuth({
  appName: "Celluloid",
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? process.env.NEXT_PUBLIC_SITE_URL,
  database: prismaAdapter(prisma, { provider: "postgresql" }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: signupsDisabled,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 10,
  },

  trustedOrigins,

  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh daily
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },

  plugins: [twoFactor(), nextCookies()], // nextCookies must be last
});

export type Session = typeof auth.$Infer.Session;
