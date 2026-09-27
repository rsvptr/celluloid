/**
 * Picks the connection string for Prisma Migrate, DDL and other operator
 * tooling. prisma.config.ts and the scripts/*.mjs files all import it, so it
 * stays plain ESM with no dependencies.
 *
 * Why the direct endpoint: Prisma Migrate takes a session-level advisory lock
 * (pg_advisory_lock) and relies on the session ending to release it. Neon's
 * pooled endpoint (the "-pooler" host) is PgBouncer in transaction mode, where
 * the server session outlives the CLI's connection. A later run can then time
 * out waiting for a lock nobody holds, and overlapping runs lose the
 * serialization the lock exists for. The direct endpoint of the same branch is
 * the same host without "-pooler".
 */

// ep-<name>[-pooler].<region…>.neon.tech. The endpoint id is the first label
// without "-pooler"; the pooled and direct hosts of one branch share it.
const NEON_HOST = /^(ep-[a-z0-9-]+?)(-pooler)?\.(?:[a-z0-9-]+\.)*neon\.tech$/i;

function matchNeonHost(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  return NEON_HOST.exec(hostname);
}

/** The Neon endpoint id ("ep-…") a connection string points at, or null for any other host. */
export function neonEndpointId(url) {
  if (!url) return null;
  return matchNeonHost(url)?.[1].toLowerCase() ?? null;
}

/**
 * The same connection string on Neon's direct endpoint, with "-pooler" removed
 * from the host. Anything else (localhost, other providers, an unparseable
 * string) comes back unchanged, byte for byte.
 */
export function toDirectUrl(url) {
  if (!url || !matchNeonHost(url)?.[2]) return url;
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/i, "");
  return parsed.toString();
}

function describeEndpoint(endpointId) {
  return endpointId ? `Neon endpoint ${endpointId}` : "an unparseable or non-Neon URL";
}

// Only called on URLs that matchNeonHost already parsed.
function databaseName(url) {
  const path = new URL(url).pathname.slice(1);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function describeDatabase(name) {
  return name ? `database "${name}"` : "the role's default database";
}

/**
 * The URL for migrations and DDL, the variable that supplied it, and whether
 * it passes the same-endpoint guard.
 *
 * Precedence: DIRECT_URL || DATABASE_URL_UNPOOLED || DATABASE_URL, whichever
 * wins passed through toDirectUrl, so a pooled string pasted into DIRECT_URL
 * still migrates over the direct host. `||` rather than `??`, so a variable
 * that is present but blank falls through.
 *
 * Guard: DIRECT_URL and DATABASE_URL_UNPOOLED both win over DATABASE_URL, so
 * either one naming another branch sends migrations away from the database
 * the app uses. That happens with a production string left in DIRECT_URL, or
 * a DATABASE_URL_UNPOOLED from `vercel env pull` / `neon env pull` after only
 * DATABASE_URL was repointed. `mismatch` describes that case, and each caller
 * decides whether to refuse or warn. Only Neon hosts are compared: a Neon host
 * on one side and anything else on the other always mismatches, while two
 * non-Neon hosts are left to the operator. On the same Neon endpoint the
 * database names must match too, since the Connect dialog defaults to neondb.
 * Roles are not compared: a separate migration role is legitimate. The message
 * names variables, endpoint ids and database names only, never credentials.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string | undefined, source: string | undefined, mismatch: string | null }}
 */
export function resolveMigrationTarget(env = process.env) {
  let url;
  let source;
  if (env.DIRECT_URL) {
    url = toDirectUrl(env.DIRECT_URL);
    source = "DIRECT_URL";
  } else if (env.DATABASE_URL_UNPOOLED) {
    url = toDirectUrl(env.DATABASE_URL_UNPOOLED);
    source = "DATABASE_URL_UNPOOLED";
  } else if (env.DATABASE_URL) {
    url = toDirectUrl(env.DATABASE_URL);
    source = "DATABASE_URL";
  }

  let mismatch = null;
  if (source && source !== "DATABASE_URL" && env.DATABASE_URL) {
    const migrationEndpoint = neonEndpointId(url);
    const appEndpoint = neonEndpointId(env.DATABASE_URL);
    let difference = null;
    if (migrationEndpoint !== appEndpoint) {
      difference =
        `${source} points at ${describeEndpoint(migrationEndpoint)}, but DATABASE_URL points at ` +
        describeEndpoint(appEndpoint);
    } else if (migrationEndpoint) {
      const migrationDatabase = databaseName(url);
      const appDatabase = databaseName(env.DATABASE_URL);
      if (migrationDatabase !== appDatabase) {
        difference =
          `${source} points at ${describeDatabase(migrationDatabase)} on Neon endpoint ` +
          `${migrationEndpoint}, but DATABASE_URL points at ${describeDatabase(appDatabase)}`;
      }
    }
    if (difference) {
      mismatch =
        `${difference}, so migrations and DDL would run against a different database than the ` +
        `app. Point ${source} at the direct (non-pooler) string of the same branch and database ` +
        "as DATABASE_URL, or set it blank to derive that from DATABASE_URL.";
    }
  }
  return { url, source, mismatch };
}
