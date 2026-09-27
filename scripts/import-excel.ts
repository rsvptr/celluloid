import { register } from "node:module";
import { loadEnv } from "./load-env.mjs";

loadEnv();

// The TMDB client is marked `server-only`. Plain Node resolves that package to
// a file that throws; Next resolves it to a no-op under the "react-server"
// condition, and so does this script.
register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier !== "server-only") return nextResolve(specifier, context);
  return nextResolve(specifier, {
    ...context,
    conditions: [...context.conditions, "react-server"],
  });
}`)}`,
  import.meta.url,
);

// Load database-dependent modules only after the environment is populated.
const { runImportFromEnv } = await import("../src/lib/import/run-import");

async function main() {
  console.log("Celluloid — importing library from workbook...\n");
  const r = await runImportFromEnv();
  console.log(
    `\nDone: created ${r.created}, updated ${r.updated}, matched ${r.matched}/${r.total}, seasons ${r.seasons}, episodes ${r.episodes}.`,
  );
  if (r.unmatched.length) {
    console.log(`\nUnmatched (${r.unmatched.length}) — added with workbook data only:`);
    r.unmatched.forEach((u) => console.log("  -", u));
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
