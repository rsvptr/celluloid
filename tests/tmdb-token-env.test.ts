import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "./server-only-shim";

// env.ts validates process.env when it is first evaluated. A distinct query
// string makes each case a fresh module instance, so each one validates the
// environment it set up.
const saved = { ...process.env };
let instance = 0;

async function loadEnv(overrides: Record<string, string>) {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/celluloid_test",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-chars",
    ...overrides,
  });
  instance += 1;
  return import(`../src/lib/env.ts?tmdb-token-${instance}`);
}

const production = {
  VERCEL: "1",
  VERCEL_ENV: "production",
  BETTER_AUTH_URL: "https://celluloid.example.test",
  NEXT_PUBLIC_SITE_URL: "https://celluloid.example.test",
  ENCRYPTION_KEY: "production-encryption-key-at-least-32-chars",
};
// Shaped like TMDB's Read Access Token; not a real credential.
const jwtShaped = "eyJhbGciOiJIUzI1NiJ9.eyJzY29wZXMiOlsiYXBpX3JlYWQiXX0.c2lnbmF0dXJl";

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe("TMDB token shape (TM-14)", { concurrency: false }, () => {
  it("keeps CI and test placeholders working outside production", async () => {
    for (const token of ["ci-placeholder-tmdb-token-not-real-0000", "test-tmdb-token"]) {
      const { env } = await loadEnv({ TMDB_ACCESS_TOKEN: token });
      assert.equal(env.TMDB_ACCESS_TOKEN, token);
    }
  });

  it("refuses a v3 API key everywhere, naming the token to use", async () => {
    await assert.rejects(
      loadEnv({ TMDB_ACCESS_TOKEN: "0123456789abcdef0123456789ABCDEF" }),
      /TMDB_ACCESS_TOKEN: use TMDB's API Read Access Token .*not the v3 API key/,
    );
  });

  it("requires the Read Access Token's JWT shape in production", async () => {
    await assert.rejects(
      loadEnv({ ...production, TMDB_ACCESS_TOKEN: "ci-placeholder-tmdb-token-not-real-0000" }),
      /TMDB_ACCESS_TOKEN: must be a JWT in production/,
    );
    const { env } = await loadEnv({ ...production, TMDB_ACCESS_TOKEN: jwtShaped });
    assert.equal(env.TMDB_ACCESS_TOKEN, jwtShaped);
  });
});
