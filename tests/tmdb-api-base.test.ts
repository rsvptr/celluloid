import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

const { resolveTmdbApiBase } = await import("../src/lib/tmdb");

const DEFAULT = "https://api.themoviedb.org/3";
const STUB = "http://127.0.0.1:3101";

const originalFetch = globalThis.fetch;
const savedBase = process.env.TMDB_API_BASE_URL;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (savedBase === undefined) delete process.env.TMDB_API_BASE_URL;
  else process.env.TMDB_API_BASE_URL = savedBase;
});

describe("TMDB_API_BASE_URL (test-only TMDB override)", { concurrency: false }, () => {
  it("defaults to TMDB when unset or blank", () => {
    assert.equal(resolveTmdbApiBase({}), DEFAULT);
    assert.equal(resolveTmdbApiBase({ TMDB_API_BASE_URL: "  " }), DEFAULT);
  });

  it("uses a set http(s) URL outside production, without a trailing slash", () => {
    assert.equal(resolveTmdbApiBase({ TMDB_API_BASE_URL: STUB }), STUB);
    assert.equal(resolveTmdbApiBase({ TMDB_API_BASE_URL: `${STUB}/3/` }), `${STUB}/3`);
    assert.equal(
      resolveTmdbApiBase({ TMDB_API_BASE_URL: "https://localhost:8443/api" }),
      "https://localhost:8443/api",
    );
    assert.equal(
      resolveTmdbApiBase({ TMDB_API_BASE_URL: "http://[::1]:3101" }),
      "http://[::1]:3101",
    );
    // `next build`, and a Vercel preview running the production build.
    assert.equal(
      resolveTmdbApiBase({
        TMDB_API_BASE_URL: STUB,
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      }),
      STUB,
    );
    assert.equal(
      resolveTmdbApiBase({
        TMDB_API_BASE_URL: STUB,
        NODE_ENV: "production",
        VERCEL: "1",
        VERCEL_ENV: "preview",
      }),
      STUB,
    );
  });

  it("is ignored on a production deployment, even when invalid", () => {
    for (const value of [STUB, "not a url"]) {
      assert.equal(
        resolveTmdbApiBase({
          TMDB_API_BASE_URL: value,
          NODE_ENV: "production",
          VERCEL: "1",
          VERCEL_ENV: "production",
        }),
        DEFAULT,
      );
      // Self-hosted `next start`.
      assert.equal(
        resolveTmdbApiBase({ TMDB_API_BASE_URL: value, NODE_ENV: "production" }),
        DEFAULT,
      );
    }
  });

  it("refuses anything but a plain http(s) URL on this machine", () => {
    for (const value of [
      "not a url",
      "https://tmdb.example.test/api",
      "http://10.0.0.5:3101",
      "http://127.0.0.1.example.test:3101",
      "127.0.0.1:3101",
      "ftp://127.0.0.1:3101",
      "http://user:secret@127.0.0.1:3101",
      "http://127.0.0.1:3101/?api_key=x",
      "http://127.0.0.1:3101/#x",
    ]) {
      assert.throws(
        () => resolveTmdbApiBase({ TMDB_API_BASE_URL: value }),
        /TMDB_API_BASE_URL must be an http\(s\) URL/,
        value,
      );
    }
  });

  // Two copies of one test: keep them the same.
  it("treats the same deployments as production as env.ts does", async () => {
    const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
    const test = (source: string, name: string, env: string) =>
      (source.match(new RegExp(`const ${name} =\\s*([^;]+);`))?.[1] ?? assert.fail(`${name} not found`))
        .replaceAll(env, "env.")
        .replace(/\s+/g, " ");
    assert.equal(
      test(await read("../src/lib/tmdb.ts"), "production", "source."),
      test(await read("../src/lib/env.ts"), "isProductionDeployment", "process.env."),
    );
  });

  it("sends every request to the configured root", async () => {
    process.env.TMDB_API_BASE_URL = `${STUB}/3/`;
    process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";
    // A fresh module instance reads the override at load, as the server does.
    const fresh = "../src/lib/tmdb.ts?api-base";
    const { getMovie, TMDB_API_BASE } = await import(fresh);
    assert.equal(TMDB_API_BASE, `${STUB}/3`);

    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
      return Response.json({ id: 603 });
    }) as typeof fetch;
    await getMovie(603);
    assert.deepEqual(urls, [`${STUB}/3/movie/603?language=en-US`]);
  });
});
