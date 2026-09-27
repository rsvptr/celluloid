import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { getMovie, searchMulti, TmdbError, tmdbErrorCode } from "../src/lib/tmdb";

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalAbortTimeout = AbortSignal.timeout;
const originalToken = process.env.TMDB_ACCESS_TOKEN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalDateNow;
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
  AbortSignal.timeout = originalAbortTimeout;
  if (originalToken === undefined) delete process.env.TMDB_ACCESS_TOKEN;
  else process.env.TMDB_ACCESS_TOKEN = originalToken;
});

describe("TMDB request budget", { concurrency: false }, () => {
  it("caps Retry-After and the next attempt at the remaining deadline", async () => {
    process.env.TMDB_ACCESS_TOKEN = "inert-test-token";
    let clock = 0;
    let fetchCalls = 0;
    const timeoutBudgets: number[] = [];
    Date.now = () => clock;
    AbortSignal.timeout = ((ms: number) => {
      timeoutBudgets.push(ms);
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout;
    globalThis.setTimeout = ((callback: () => void, ms = 0) => {
      clock += ms;
      queueMicrotask(callback);
      return 1;
    }) as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response("unavailable", {
        status: 503,
        headers: { "Retry-After": "5" },
      });
    }) as typeof fetch;

    await assert.rejects(
      searchMulti("Heat", 1, { deadlineMs: 1_000, retries: 3 }),
      /deadline/i,
    );

    assert.equal(fetchCalls, 1);
    assert.deepEqual(timeoutBudgets, [1_000]);
    assert.equal(clock, 1_000);
  });

  it("cancels a retry backoff through the caller signal", async () => {
    process.env.TMDB_ACCESS_TOKEN = "inert-test-token";
    const controller = new AbortController();
    let timerCleared = false;
    let sleepScheduled = false;
    AbortSignal.timeout = (() => new AbortController().signal) as typeof AbortSignal.timeout;
    globalThis.fetch = (async () => new Response("unavailable", { status: 503 })) as typeof fetch;
    globalThis.setTimeout = ((() => {
      sleepScheduled = true;
      return 7;
    }) as unknown) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      if (id === 7) timerCleared = true;
    }) as typeof clearTimeout;

    const request = searchMulti("Heat", 1, {
      deadlineMs: 10_000,
      retries: 3,
      signal: controller.signal,
    });
    while (!sleepScheduled) await Promise.resolve();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await assert.rejects(request, /cancelled/i);
    assert.equal(timerCleared, true);
  });
});

describe("TMDB error responses", { concurrency: false }, () => {
  it("reads TMDB's status_code from an error body", () => {
    assert.equal(tmdbErrorCode('{"success":false,"status_code":34,"status_message":"x"}'), 34);
    assert.equal(tmdbErrorCode('{"status_message":"no code"}'), null);
    assert.equal(tmdbErrorCode("<html>Bad gateway</html>"), null);
    assert.equal(tmdbErrorCode(""), null);
  });

  it("throws a typed error carrying the HTTP status and TMDB code", async () => {
    process.env.TMDB_ACCESS_TOKEN = "inert-test-token";
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ success: false, status_code: 34 }, { status: 404 });
    }) as typeof fetch;

    await assert.rejects(getMovie(1), (err: unknown) => {
      assert.ok(err instanceof TmdbError);
      assert.equal(err.status, 404);
      assert.equal(err.code, 34);
      assert.match(err.message, /^TMDB 404 on \/movie\/1: /);
      return true;
    });
    assert.equal(calls, 1, "a 404 is not retried");
  });
});
