/**
 * Applies pending Prisma migrations to the PRODUCTION database.
 *
 * Production is deliberately NOT reachable through DATABASE_URL: that variable
 * points at the dev branch during development, and a script that silently used
 * whatever was in it would eventually run against the wrong database. Instead
 * this reads PROD_DATABASE_URL, refuses to run without it, and shows which host
 * it is about to touch before doing anything.
 *
 * Forward-only: it shells out to `prisma migrate deploy`, which applies pending
 * migrations and nothing else — it never resets, drops, or generates SQL. Run
 * the same migrations against the dev branch first (`npm run db:deploy`).
 *
 * Usage: npm run db:deploy:prod        (add --yes to skip the confirmation)
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const url = process.env.PROD_DATABASE_URL;
if (!url) {
  console.error(
    "PROD_DATABASE_URL is not set. Add the production connection string to your\n" +
      "environment (see .env.example) before deploying migrations to production.",
  );
  process.exit(1);
}

/** Host only — the connection string carries credentials that must not be printed. */
function describeTarget(connectionString) {
  try {
    const { host, pathname } = new URL(connectionString);
    return `${host}${pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

const target = describeTarget(url);
if (/-pooler\./.test(target)) {
  // Neon's pooled endpoint works for migrations, but the direct endpoint avoids
  // pooler-side statement timeouts on long DDL. Worth saying, not worth blocking.
  console.warn(`Note: ${target} is a pooled endpoint; the direct one is safer for long DDL.\n`);
}

console.log(`About to apply pending migrations to PRODUCTION: ${target}`);

if (!process.argv.includes("--yes")) {
  // A closed/piped stdin can never answer the prompt, and waiting on one just
  // hangs (CI, a background shell). Refuse instead, and say how to proceed.
  if (!stdin.isTTY) {
    console.error(
      "Refusing to deploy: stdin is not interactive, so the confirmation cannot be\n" +
        "answered. Re-run in a terminal, or pass --yes if you have already verified\n" +
        "the target above.",
    );
    process.exit(1);
  }
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Type "deploy" to continue: ');
  rl.close();
  if (answer.trim() !== "deploy") {
    console.log("Aborted; nothing was applied.");
    process.exit(1);
  }
}

// prisma.config.ts resolves the datasource from DIRECT_URL ?? DATABASE_URL, so
// both are overridden here to keep the child process off the dev branch even if
// the ambient environment has them set.
//
// Invoked through the prisma package's JS entry with the current Node rather
// than the `npx` shim: on Windows, spawning a `.cmd` without a shell fails with
// EINVAL on patched Node (the .bat/.cmd injection fix), and `shell: true` would
// reintroduce quoting hazards.
const prismaBin = fileURLToPath(
  new URL("../node_modules/prisma/build/index.js", import.meta.url),
);
const result = spawnSync(
  process.execPath,
  [prismaBin, "migrate", "deploy"],
  {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  },
);

process.exit(result.status ?? 1);
