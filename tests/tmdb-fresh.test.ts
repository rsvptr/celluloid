import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

const { appendedSeasons, getMovie, getSeasons, getTv, MAX_APPENDED_SEASONS } = await import(
  "../src/lib/tmdb"
);

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
    await getSeasons(2, [{ id: 21, season_number: 1 }], { fresh: true });

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

describe("appended season requests", { concurrency: false }, () => {
  const season = (n: number) => ({
    season_number: n,
    name: `Season ${n}`,
    overview: "",
    air_date: null,
    poster_path: null,
    episodes: [],
  });

  it("takes season ids from the show's list and leaves out seasons TMDB omitted", () => {
    assert.deepEqual(
      appendedSeasons({ id: 9, name: "Show", "season/1": season(1), "season/3": season(3) }, [
        { id: 101, season_number: 1 },
        { id: 102, season_number: 2 },
        { id: 103, season_number: 3 },
      ]),
      [
        { n: 1, sd: { ...season(1), id: 101 } },
        { n: 3, sd: { ...season(3), id: 103 } },
      ],
    );
  });

  it("asks for a chunk of seasons on one show request", async () => {
    const calls: URL[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(new URL(String(input)));
      return Response.json({ id: 2, "season/1": season(1), "season/2": season(2) });
    }) as typeof fetch;

    const seasons = await getSeasons(2, [
      { id: 21, season_number: 1 },
      { id: 22, season_number: 2 },
    ]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].pathname, "/3/tv/2");
    assert.equal(calls[0].searchParams.get("append_to_response"), "season/1,season/2");
    assert.equal(calls[0].searchParams.get("language"), "en-US");
    assert.deepEqual(
      seasons.map(({ n, sd }) => [n, sd.id]),
      [
        [1, 21],
        [2, 22],
      ],
    );
    // TMDB answers 400 (code 27) past 20 appends.
    assert.equal(MAX_APPENDED_SEASONS, 20);
  });
});
