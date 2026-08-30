import { resolve } from "node:path";
import { config } from "dotenv";

/**
 * Load local operator configuration with the same precedence as Next.js:
 * existing process environment, then .env.local, then .env for missing keys.
 */
export function loadEnv({ cwd = process.cwd(), processEnv = process.env } = {}) {
  return config({
    path: [resolve(cwd, ".env.local"), resolve(cwd, ".env")],
    processEnv,
    quiet: true,
  });
}
