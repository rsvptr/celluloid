import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { describe, it } from "node:test";
import { isValidElement, Suspense, type ReactElement } from "react";

let lookup: (userId: string) => Promise<unknown> = async () => null;
const lookups: string[] = [];
Object.assign(globalThis, {
  __CELLULOID_ACTIVE_IMPORT__: (userId: string) => {
    lookups.push(userId);
    return lookup(userId);
  },
});

const loader = `
const stubs = {
  "/src/lib/import-staging":
    "export function getActiveImportJobView(id) { return globalThis.__CELLULOID_ACTIVE_IMPORT__(id); }",
  "/src/lib/session":
    "export async function requireUser() { return { id: 'user-1' }; }",
  "/src/app/(app)/add/add-search": "export function AddSearch() { return null; }",
  "/src/app/(app)/add/import-upload": "export function ImportUpload() { return null; }",
};
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.tsx?$/, "");
  for (const [path, source] of Object.entries(stubs)) {
    const alias = "@/" + path.slice("/src/".length);
    const relative = "./" + path.split("/").pop();
    const fromPage = context.parentURL?.includes("/src/app/(app)/add/page");
    if (specifier === alias || normalized.endsWith(path) || (fromPage && specifier === relative)) {
      return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { default: AddPage } = await import("../src/app/(app)/add/page");

type Props = Record<string, unknown>;

/** Renders the page, then the server component inside its Suspense boundary. */
async function importSection(): Promise<Props> {
  const page = (await AddPage({ searchParams: Promise.resolve({}) })) as ReactElement<Props>;
  let boundary: ReactElement<Props> | null = null;
  const walk = (node: unknown) => {
    if (!isValidElement<Props>(node)) {
      if (Array.isArray(node)) node.forEach(walk);
      return;
    }
    if (node.type === Suspense) boundary = node;
    walk(node.props.children);
  };
  walk(page);
  assert.ok(boundary, "no Suspense boundary around the import section");
  const section = (boundary as ReactElement<Props>).props.children as ReactElement<Props>;
  const render = section.type as (props: Props) => Promise<ReactElement<Props>>;
  return (await render(section.props)).props;
}

// VE-12: /add used to fetch the active import after hydration, pausing uploads
// until it answered. The page now runs the same lookup on the server.
describe("/add active import check (VE-12)", { concurrency: false }, () => {
  it("passes the signed-in user's open job to the upload", async () => {
    const job = { id: "job-1", items: [] };
    lookup = async () => job;
    lookups.length = 0;
    const props = await importSection();
    assert.deepEqual(lookups, ["user-1"]);
    assert.equal(props.initialJob, job);
    assert.equal(props.initialActiveError, null);
  });

  it("keeps uploads paused with the route's message when the lookup fails", async () => {
    lookup = async () => {
      throw new Error("db down");
    };
    const originalError = console.error;
    console.error = () => {};
    try {
      const props = await importSection();
      assert.equal(props.initialJob, null);
      assert.equal(
        props.initialActiveError,
        "Celluloid couldn't verify unfinished imports. Uploads are paused; try again.",
      );
    } finally {
      console.error = originalError;
    }
  });

  it("no longer fetches on mount and loads the review lazily", async () => {
    const upload = await readFile(
      new URL("../src/app/(app)/add/import-upload.tsx", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(upload, /useEffect/);
    assert.doesNotMatch(upload, /^import[^;]*["']@\/components\/import-review["']/m);
    assert.match(upload, /dynamic\(\s*\(\) => import\("@\/components\/import-review"\)/);
    // Retry check still goes through the route.
    assert.match(upload, /fetch\("\/api\/import\/jobs\/active"/);
  });
});
