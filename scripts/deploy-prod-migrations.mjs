/**
 * Applies pending Prisma migrations to the PRODUCTION database.
 *
 * Production is deliberately NOT reachable through DATABASE_URL: that variable
 * points at the dev branch during development, and a script that silently used
 * whatever was in it would eventually run against the wrong database. Instead
 * this reads PROD_DATABASE_URL, refuses to run without it, and shows what it is
 * about to touch before doing anything: the Neon endpoint, the database, and
 * the migration folders `prisma migrate status` reports as pending. It applies
 * whatever folders exist in this working copy, so it also warns when
 * prisma/migrations has uncommitted changes. It warns, too, when
 * PROD_DATABASE_URL and DATABASE_URL name the same Neon endpoint.
 *
 * Migrations go to production's DIRECT endpoint even when PROD_DATABASE_URL is
 * the pooled string: Prisma Migrate's session-level advisory lock doesn't
 * survive Neon's transaction-mode pooler (see scripts/db-urls.mjs).
 *
 * Forward-only: it shells out to `prisma migrate deploy`, which applies pending
 * migrations and nothing else. It never resets, drops, or generates SQL.
 * Rehearse them first on a fresh copy of production, not a long-lived dev
 * branch: a PR's preview branch, or a short-lived child branch (README).
 *
 * Usage: npm run db:deploy:prod        (add --yes to skip the confirmation)
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { neonEndpointId, toDirectUrl } from "./db-urls.mjs";
import { loadEnv } from "./load-env.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The environment for the Prisma child processes. prisma.config.ts resolves
 * DIRECT_URL first and refuses when it names a different Neon endpoint than
 * DATABASE_URL, so both are pinned to production: DIRECT_URL to the direct
 * form of PROD_DATABASE_URL, DATABASE_URL to it as given. That also keeps the
 * dev branch in .env.local, or an ambient DATABASE_URL_UNPOOLED, out of play.
 *
 * @param {string} prodUrl
 * @param {Record<string, string | undefined>} [env]
 * @returns {Record<string, string | undefined>}
 */
export function prodMigrationEnv(prodUrl, env = process.env) {
  return { ...env, DATABASE_URL: prodUrl, DIRECT_URL: toDirectUrl(prodUrl) };
}

/** Endpoint, host and database only; the connection string carries credentials that must not be printed. */
export function describeTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    return { endpoint: "(unparseable connection string)", host: "?", database: "?" };
  }
  return {
    endpoint: neonEndpointId(connectionString) ?? "(not a Neon host)",
    host: parsed.host,
    database: parsed.pathname.slice(1) || "(the role's default database)",
  };
}

/**
 * A banner warning when PROD_DATABASE_URL and DATABASE_URL name the same Neon
 * endpoint (pooled or direct): either "production" is the dev branch, or the
 * dev variable holds production. Null when the endpoints differ or either
 * value isn't a Neon URL. Names the endpoint id only, never credentials.
 */
export function sameEndpointWarning(prodUrl, appUrl) {
  const endpoint = neonEndpointId(prodUrl);
  if (!endpoint || endpoint !== neonEndpointId(appUrl)) return null;
  return (
    `Warning: PROD_DATABASE_URL and DATABASE_URL both point at Neon endpoint ${endpoint}.\n` +
    "Either PROD_DATABASE_URL is your dev branch, or DATABASE_URL (which the app and\n" +
    "dev tooling use) points at production. Check both before continuing.\n"
  );
}

/**
 * The local migration folders `prisma migrate status` lists under its "have
 * not yet been applied" heading, which is also printed when histories diverge.
 * Matching against folders that exist here keeps a changed output format from
 * turning stray lines into "pending migrations".
 */
export function pendingMigrations(statusOutput, localMigrations) {
  const lines = statusOutput.split(/\r?\n/).map((line) => line.trim());
  const heading = lines.findIndex((line) => line.endsWith("have not yet been applied:"));
  if (heading === -1) return [];
  const listed = new Set();
  for (const line of lines.slice(heading + 1)) {
    if (!line) break;
    listed.add(line);
  }
  return localMigrations.filter((name) => listed.has(name));
}

function localMigrationFolders() {
  return readdirSync(new URL("../prisma/migrations/", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function warnAboutUncommittedMigrations() {
  const git = spawnSync("git", ["status", "--porcelain", "--", "prisma/migrations"], {
    cwd: root,
    encoding: "utf8",
  });
  if (git.status !== 0) {
    console.warn("Warning: couldn't check prisma/migrations for uncommitted changes (git status failed).\n");
  } else if (git.stdout.trim()) {
    // A warning, not a refusal: promoting a migration before committing it is
    // a legitimate workflow. The pending list below shows what will run.
    console.warn(
      "Warning: prisma/migrations has uncommitted changes, and this applies whatever\n" +
        `folders exist in this working copy, committed or not:\n${git.stdout.trimEnd()}\n`,
    );
  }
}

// Invoked through the prisma package's JS entry with the current Node rather
// than the `npx` shim: on Windows, spawning a `.cmd` without a shell fails with
// EINVAL on patched Node (the .bat/.cmd injection fix), and `shell: true` would
// reintroduce quoting hazards.
const prismaBin = fileURLToPath(
  new URL("../node_modules/prisma/build/index.js", import.meta.url),
);

function showPendingMigrations(env) {
  const status = spawnSync(process.execPath, [prismaBin, "migrate", "status"], {
    env,
    encoding: "utf8",
  });
  // `migrate status` exits 1 whenever migrations are pending (Prisma 7.10), so
  // its exit code is reported, never used to stop the deploy.
  const output = `${status.stdout ?? ""}${status.stderr ?? ""}`.trim();
  console.log(`prisma migrate status (exit ${status.status ?? status.error?.message}):`);
  console.log(`${output.replace(/^/gm, "  ")}\n`);

  const pending = pendingMigrations(output, localMigrationFolders());
  if (pending.length > 0) {
    console.log(`Pending migration folders (${pending.length}):\n${pending.map((name) => `  ${name}`).join("\n")}\n`);
  } else if (status.status === 0) {
    console.log("No pending migrations: the status above reports the database is up to date.\n");
  } else {
    console.log("No pending migration folders could be read from the status above. Check it before continuing.\n");
  }
}

async function confirmDeploy() {
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

async function main() {
  loadEnv();

  const prodUrl = process.env.PROD_DATABASE_URL;
  if (!prodUrl) {
    console.error(
      "PROD_DATABASE_URL is not set. Add the production connection string to your\n" +
        "environment (see .env.example) before deploying migrations to production.",
    );
    process.exit(1);
  }

  const env = prodMigrationEnv(prodUrl);
  const target = describeTarget(env.DIRECT_URL);
  const hostNote = env.DIRECT_URL !== prodUrl ? " (direct host; PROD_DATABASE_URL is the pooled one)" : "";
  console.log(
    "About to apply pending migrations to PRODUCTION:\n" +
      `  Neon endpoint: ${target.endpoint}\n` +
      `  Host:          ${target.host}${hostNote}\n` +
      `  Database:      ${target.database}\n`,
  );
  // process.env still holds DATABASE_URL as loaded; only the child env is pinned.
  const sameEndpoint = sameEndpointWarning(prodUrl, process.env.DATABASE_URL);
  if (sameEndpoint) console.warn(sameEndpoint);

  warnAboutUncommittedMigrations();
  showPendingMigrations(env);
  console.log("Snapshot first if you haven't: npm run db:dump -- --target prod\n");

  if (!process.argv.includes("--yes")) await confirmDeploy();

  const result = spawnSync(process.execPath, [prismaBin, "migrate", "deploy"], {
    stdio: "inherit",
    env,
  });
  process.exit(result.status ?? 1);
}

// Node resolves symlinks in import.meta.url but not in argv[1].
const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) await main();
