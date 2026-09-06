import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { getMovie, getSeason, getTv } from "../src/lib/tmdb";

process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fresh TMDB detail reads", { concurrency: false }, () => {
  it("sends no-store without a conflicting Next revalidation option", async () => {
    const calls: Array<{ path: string; init?: RequestInit & { next?: unknown } }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ path: new URL(String(input)).pathname, init });
      return Response.json({ id: 1, seasons: [], episodes: [] });
    }) as typeof fetch;

    await getMovie(1, { fresh: true });
    await getTv(2, { fresh: true });
    await getSeason(2, 1, { fresh: true });

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.init?.cache, "no-store", call.path);
      assert.equal(call.init?.next, undefined, call.path);
    }
  });

  it("keeps display reads cached and wires fresh reads into add and rematch", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return Response.json({ id: 1, seasons: [] });
    }) as typeof fetch;

    await getTv(1);
    assert.equal(calls[0].cache, undefined);
    assert.equal(
      (calls[0] as RequestInit & { next?: { revalidate?: number | false } }).next
        ?.revalidate,
      86_400,
    );

    const actionsSource = await readFile(
      new URL("../src/lib/actions.ts", import.meta.url),
      "utf8",
    );
    assert.match(actionsSource, /getMovie\(tmdbId, \{ fresh: true \}\)/);
    assert.match(actionsSource, /getTv\(tmdbId, \{ fresh: true \}\)/);
    assert.match(
      actionsSource,
      /fetchSeasonData\(tmdbId, tv, \{ fresh: true \}\)/,
    );
  });
});
