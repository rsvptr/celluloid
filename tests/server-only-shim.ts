import { register } from "node:module";

/**
 * Lets a test load a module marked `import "server-only"` (src/lib/tmdb.ts).
 * Plain Node resolves that package to a file that throws; Next resolves it to a
 * no-op under the "react-server" condition, and this hook does the same.
 *
 * Import this file first, then load the server module with a dynamic import:
 * static imports are all resolved before this file's body runs.
 */
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
