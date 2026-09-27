import "server-only";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

// Strictness keys on the actual DEPLOYMENT, not NODE_ENV alone: `next build`
// always sets NODE_ENV=production, so keying on NODE_ENV by itself would break
// local builds against localhost URLs. Two shapes count as production:
// - Vercel: VERCEL_ENV === "production" (matches the vercel-build guard;
//   preview deploys stay relaxed on purpose).
// - Self-hosted `next start`: NODE_ENV=production at RUNTIME, excluding the
//   build phase via NEXT_PHASE (set only while `next build` runs). Keying on
//   VERCEL_ENV alone silently disabled every production check — required
//   origins, HTTPS, the no-key-reuse rule — for anyone running this off
//   Vercel with plain `npm start`.
const isProductionDeployment =
  process.env.VERCEL_ENV === "production" ||
  (!process.env.VERCEL &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build");

/**
 * Floor for anything used as key material. 32 characters is what the documented
 * generators (`npx auth@latest secret`, `openssl rand -base64 32`) produce, and
 * BETTER_AUTH_SECRET is not just a session signing key: outside production it is
 * also the fallback input to the AES-256-GCM key derivation in lib/crypto, so a
 * short value silently weakens secrets at rest too.
 */
const MIN_SECRET_LENGTH = 32;
const MIN_INVITE_CODE_LENGTH = 16;

/**
 * TMDB's API Read Access Token is a JWT. Its v3 "API key" is 32 hex characters
 * and fails every Bearer request with 401 (code 7), so a pasted v3 key is
 * refused everywhere. The JWT shape itself is only required in production,
 * which keeps CI and test placeholders working.
 */
const TMDB_V3_API_KEY = /^[0-9a-f]{32}$/i;
const TMDB_READ_ACCESS_TOKEN = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const TMDB_TOKEN_HINT =
  "use TMDB's API Read Access Token (the long token starting with eyJ), not the v3 API key";

const optionalInviteCode = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z
    .string()
    .trim()
    .min(
      MIN_INVITE_CODE_LENGTH,
      `must be at least ${MIN_INVITE_CODE_LENGTH} characters — generate one with: openssl rand -base64 24`,
    )
    .optional(),
);

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().trim().min(1),
    BETTER_AUTH_SECRET: z
      .string()
      .trim()
      .min(
        MIN_SECRET_LENGTH,
        `must be at least ${MIN_SECRET_LENGTH} characters — generate one with: npx auth@latest secret`,
      ),
    BETTER_AUTH_URL: optionalString,
    NEXT_PUBLIC_SITE_URL: optionalString,
    ENCRYPTION_KEY: optionalString,
    TMDB_ACCESS_TOKEN: z
      .string()
      .trim()
      .min(1)
      .refine((token) => !TMDB_V3_API_KEY.test(token), TMDB_TOKEN_HINT),
    ANTHROPIC_API_KEY: optionalString,
    SIGNUP_INVITE_CODE: optionalInviteCode,
  })
  .superRefine((value, ctx) => {
    let databaseUrl: URL | null = null;
    try {
      databaseUrl = new URL(value.DATABASE_URL);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "must be a valid PostgreSQL connection URL",
      });
    }
    if (
      databaseUrl &&
      databaseUrl.protocol !== "postgresql:" &&
      databaseUrl.protocol !== "postgres:"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["DATABASE_URL"],
        message: "must use the postgresql: or postgres: protocol",
      });
    }

    if (isProductionDeployment) {
      for (const key of ["BETTER_AUTH_URL", "NEXT_PUBLIC_SITE_URL"] as const) {
        if (!value[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "is required in production",
          });
        }
      }
      if (!value.ENCRYPTION_KEY) {
        ctx.addIssue({
          code: "custom",
          path: ["ENCRYPTION_KEY"],
          message: "is required in production and cannot fall back to BETTER_AUTH_SECRET",
        });
      } else if (value.ENCRYPTION_KEY.length < MIN_SECRET_LENGTH) {
        // Presence alone is not enough: this value is the sole input to the
        // key derivation for secrets at rest, so a weak one is as bad as none.
        ctx.addIssue({
          code: "custom",
          path: ["ENCRYPTION_KEY"],
          message: `must be at least ${MIN_SECRET_LENGTH} characters in production — generate one with: openssl rand -base64 32`,
        });
      }
      if (!TMDB_READ_ACCESS_TOKEN.test(value.TMDB_ACCESS_TOKEN)) {
        ctx.addIssue({
          code: "custom",
          path: ["TMDB_ACCESS_TOKEN"],
          message: `must be a JWT in production: ${TMDB_TOKEN_HINT}`,
        });
      }
    }

    const parsedUrls = new Map<string, URL>();
    for (const key of ["BETTER_AUTH_URL", "NEXT_PUBLIC_SITE_URL"] as const) {
      const candidate = value[key];
      if (!candidate) continue;
      try {
        const url = new URL(candidate);
        parsedUrls.set(key, url);
        if (
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        ) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must be an origin URL without credentials, a path, query, or hash",
          });
        }
        if (isProductionDeployment && url.protocol !== "https:") {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: "must use HTTPS in production",
          });
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "must be a valid absolute URL",
        });
      }
    }

    const authUrl = parsedUrls.get("BETTER_AUTH_URL");
    const publicUrl = parsedUrls.get("NEXT_PUBLIC_SITE_URL");
    if (authUrl && publicUrl && authUrl.origin !== publicUrl.origin) {
      ctx.addIssue({
        code: "custom",
        path: ["BETTER_AUTH_URL"],
        message: "must match NEXT_PUBLIC_SITE_URL",
      });
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SITE_URL"],
        message: "must match BETTER_AUTH_URL",
      });
    }
  });

function parseEnvironment(source: NodeJS.ProcessEnv) {
  const result = rawEnvSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("\n- ");
    throw new Error(`Invalid Celluloid environment:\n- ${details}`);
  }
  return result.data;
}

const parsed = parseEnvironment(process.env);
const developmentOrigin = "http://localhost:3000";

/** Validated server-side environment. Imported modules fail fast on bad config. */
export const env = Object.freeze({
  NODE_ENV: parsed.NODE_ENV,
  DATABASE_URL: parsed.DATABASE_URL,
  BETTER_AUTH_SECRET: parsed.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL:
    parsed.BETTER_AUTH_URL ?? parsed.NEXT_PUBLIC_SITE_URL ?? developmentOrigin,
  NEXT_PUBLIC_SITE_URL:
    parsed.NEXT_PUBLIC_SITE_URL ?? parsed.BETTER_AUTH_URL ?? developmentOrigin,
  ENCRYPTION_KEY: parsed.ENCRYPTION_KEY ?? parsed.BETTER_AUTH_SECRET,
  TMDB_ACCESS_TOKEN: parsed.TMDB_ACCESS_TOKEN,
  ANTHROPIC_API_KEY: parsed.ANTHROPIC_API_KEY,
  SIGNUP_INVITE_CODE: parsed.SIGNUP_INVITE_CODE,
});

export type CelluloidEnv = typeof env;
