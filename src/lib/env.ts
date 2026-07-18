import "server-only";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().optional(),
);

// Strictness keys on the actual DEPLOYMENT, not NODE_ENV: `next build` always
// sets NODE_ENV=production, so keying on it breaks local builds against
// localhost URLs. VERCEL_ENV === "production" matches the repo's vercel-build
// guard and fires only on real production deploys.
const isProductionDeployment = process.env.VERCEL_ENV === "production";

const rawEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().trim().min(1),
    BETTER_AUTH_SECRET: z.string().trim().min(1),
    BETTER_AUTH_URL: optionalString,
    NEXT_PUBLIC_SITE_URL: optionalString,
    ENCRYPTION_KEY: optionalString,
    TMDB_ACCESS_TOKEN: z.string().trim().min(1),
    ANTHROPIC_API_KEY: optionalString,
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
});

export type CelluloidEnv = typeof env;
