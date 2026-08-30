import { loadEnv } from "./load-env.mjs";

loadEnv();

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
