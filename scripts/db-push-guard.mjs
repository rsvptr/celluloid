/**
 * Runs first in `npm run db:push` and stops it unless ALLOW_DB_PUSH=1 is set
 * for that command (PR-12). `prisma db push` changes the schema without a
 * migration, and Prisma points it at the same database `db:migrate` manages,
 * so the next `prisma migrate dev` sees drift and offers to reset the branch.
 *
 * Only the process environment counts, not .env.local, so the opt-in can't be
 * left switched on by accident.
 *
 * Usage: ALLOW_DB_PUSH=1 npm run db:push   (throwaway databases only)
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Why db:push must not run, or null when ALLOW_DB_PUSH=1 opts in. */
export function pushRefusal(env) {
  if (env.ALLOW_DB_PUSH === "1") return null;
  return (
    "db:push refused. It changes the schema without a migration, on the database db:migrate manages,\n" +
    "and the next db:migrate would offer to reset that database to undo the drift.\n" +
    "Use `npm run db:migrate` for a real schema change. To prototype on a throwaway\n" +
    "database, run `ALLOW_DB_PUSH=1 npm run db:push`."
  );
}

const isDirectRun =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const refusal = pushRefusal(process.env);
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
  }
}
