import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimit, tooManyRequests } from "../src/lib/rate-limit";

describe("rateLimit", () => {
  it("allows up to the limit then blocks with a retry hint", () => {
    const key = "test:block";
    assert.equal(rateLimit(key, 3, 60_000).ok, true);
    assert.equal(rateLimit(key, 3, 60_000).ok, true);
    assert.equal(rateLimit(key, 3, 60_000).ok, true);
    const blocked = rateLimit(key, 3, 60_000);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfter >= 1);
  });

  it("tracks keys independently", () => {
    assert.equal(rateLimit("test:a", 1, 60_000).ok, true);
    assert.equal(rateLimit("test:a", 1, 60_000).ok, false);
    assert.equal(rateLimit("test:b", 1, 60_000).ok, true);
  });

  it("resets after the window passes", async () => {
    const key = "test:reset";
    assert.equal(rateLimit(key, 1, 20).ok, true);
    assert.equal(rateLimit(key, 1, 20).ok, false);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(rateLimit(key, 1, 20).ok, true);
  });
});

describe("tooManyRequests", () => {
  it("returns a 429 with a Retry-After header of at least one second", async () => {
    const res = tooManyRequests(0);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("Retry-After"), "1");
    const body = (await res.json()) as { error: string };
    assert.ok(body.error.length > 0);
  });
});
