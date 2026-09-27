import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

// VE-14: the palette revalidates the title index on every open. The route
// answers an unchanged index with an empty 304 and a changed one with the full
// list, and never lets the browser store it.

const state = {
  titles: [] as Array<{ id: string; name: string; year: number | null; mediaType: string }>,
};
Object.assign(globalThis, { __CELLULOID_TITLES_ROUTE__: state });

const stubs: Record<string, string> = {
  "@/lib/session": "export async function getSession() { return { user: { id: 'user-1' } }; }",
  "@/lib/data":
    "export async function getTitleIndex() { return globalThis.__CELLULOID_TITLES_ROUTE__.titles; }",
  "@/lib/rate-limit":
    "export function rateLimit() { return { ok: true }; }" +
    "export function tooManyRequests() { throw new Error('unexpected rate limit'); }",
};
const loader = `
const stubs = ${JSON.stringify(stubs)};
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const key = Object.keys(stubs).find(
    (name) => specifier === name || normalized.endsWith("/src/lib/" + name.slice("@/lib/".length)),
  );
  if (key) {
    return {
      url: "data:text/javascript," + encodeURIComponent(stubs[key]),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { GET } = await import("../src/app/api/titles/route");

function request(etag?: string) {
  return new Request("http://localhost/api/titles", {
    headers: etag ? { "If-None-Match": etag } : {},
  });
}

describe("title index route revalidation (VE-14)", { concurrency: false }, () => {
  beforeEach(() => {
    state.titles = [{ id: "t1", name: "Heat", year: 1995, mediaType: "MOVIE" }];
  });

  it("sends the index with an ETag and keeps it out of the browser cache", async () => {
    const response = await GET(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.match(response.headers.get("ETag") ?? "", /^W\/"[\w-]+"$/);
    assert.deepEqual(await response.json(), { titles: state.titles });
  });

  it("answers an unchanged index with an empty 304", async () => {
    const etag = (await GET(request())).headers.get("ETag")!;
    const response = await GET(request(etag));
    assert.equal(response.status, 304);
    assert.equal(response.headers.get("ETag"), etag);
    assert.equal(await response.text(), "");
  });

  it("sends the full list again once the index changed", async () => {
    const etag = (await GET(request())).headers.get("ETag")!;
    // A title added, or one moved to Trash and restored by an undo.
    state.titles = [...state.titles, { id: "t2", name: "Ran", year: 1985, mediaType: "MOVIE" }];

    const response = await GET(request(etag));
    assert.equal(response.status, 200);
    assert.notEqual(response.headers.get("ETag"), etag);
    assert.deepEqual(await response.json(), { titles: state.titles });
  });
});
