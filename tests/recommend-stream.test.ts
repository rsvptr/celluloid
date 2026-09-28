import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";

type StreamEvent = Record<string, unknown>;
type SearchResult = Array<Record<string, unknown>>;

let usedFallback = false;
let reserveCalls = 0;
let releaseCalls: string[] = [];
let reserveHook: (() => void) | null = null;
let searchCalls: string[] = [];
let searchImpl: (title: string, signal?: AbortSignal) => Promise<SearchResult> = async () => [];
let streamEvents: StreamEvent[] = [];
let streamError: Error | null = null;
let capturedRequest: unknown = null;
let ownedTitles: Array<Record<string, unknown>> = [];
let storedModel: string | null = null;

function modelRec(title: string, year = 2020) {
  return {
    title,
    year,
    mediaType: "movie",
    language: "en",
    reason: `A specific reason for ${title}.`,
    confidence: "high",
  };
}

function messageStart(): StreamEvent {
  return {
    type: "message_start",
    message: {
      usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

function textEvent(recommendations: unknown[]): StreamEvent {
  return {
    type: "content_block_delta",
    delta: {
      type: "text_delta",
      text: JSON.stringify({ recommendations }),
    },
  };
}

const fakePrisma = {
  user: { findUnique: async () => ({ recommendModel: storedModel }) },
  suppression: { findMany: async () => [] },
  title: { findMany: async () => ownedTitles },
};

Object.assign(globalThis, {
  __CELLULOID_REC_PRISMA__: fakePrisma,
  __CELLULOID_REC_ROWS__: async () => [
    {
      id: "basis-1",
      name: "Heat",
      mediaType: "movie",
      year: 1995,
      statusKey: "WATCHED",
      watchedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  __CELLULOID_REC_KEY__: async () => ({
    key: "inert-key",
    usedFallback,
    hadUserKey: !usedFallback,
  }),
  __CELLULOID_REC_RESERVE__: async () => {
    reserveCalls += 1;
    reserveHook?.();
    return { allowed: true, day: "2026-09-05", limit: 20, runCount: reserveCalls };
  },
  __CELLULOID_REC_RELEASE__: async (day: string) => {
    releaseCalls.push(day);
  },
  __CELLULOID_REC_SEARCH__: async (
    _kind: string,
    title: string,
    _page: number,
    opts?: { signal?: AbortSignal },
  ) => {
    searchCalls.push(title);
    return searchImpl(title, opts?.signal);
  },
  __CELLULOID_REC_STREAM__: (request: unknown) => {
    capturedRequest = request;
    let aborted = false;
    return {
      abort() {
        aborted = true;
      },
      async *[Symbol.asyncIterator]() {
        for (const event of streamEvents) {
          if (aborted) break;
          yield event;
        }
        if (streamError) throw streamError;
      },
    };
  },
});

const loader = `
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const source =
    (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma"))
      ? "export const prisma = globalThis.__CELLULOID_REC_PRISMA__;"
      : (specifier === "@/lib/data" || normalized.endsWith("/src/lib/data"))
        ? "export const getExportRows = globalThis.__CELLULOID_REC_ROWS__;"
        : (specifier === "@/lib/export/format" || normalized.endsWith("/src/lib/export/format"))
          ? "export const tasteSummary = () => 'One watched movie.';"
          : (specifier === "@/lib/anthropic" || normalized.endsWith("/src/lib/anthropic"))
            ? "export const resolveAnthropicKey = globalThis.__CELLULOID_REC_KEY__;" +
              "export const reserveSharedAiRun = globalThis.__CELLULOID_REC_RESERVE__;" +
              "export const releaseSharedAiRun = globalThis.__CELLULOID_REC_RELEASE__;" +
              "export const anthropicClient = () => ({ messages: { stream: globalThis.__CELLULOID_REC_STREAM__ } });" +
              "export const friendlyAnthropicError = () => 'Friendly stream error.';"
            : (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb"))
              ? "export const searchByType = globalThis.__CELLULOID_REC_SEARCH__;" +
                "export async function getGenreIdsByName() { return new Set(); }"
              : (specifier === "@/generated/prisma/client" || normalized.endsWith("/src/generated/prisma/client"))
                ? "export const MediaType = { MOVIE: 'MOVIE', TV: 'TV' };"
                : (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session"))
                  ? "export async function getSession() { return null; }"
                  : undefined;
  if (source !== undefined) {
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const {
  RECOMMEND_KEEPALIVE_MS,
  runRecommendationStream,
} = await import("../src/lib/recommend");
const { recommendRequestSchema } = await import("../src/app/api/recommend/route");

function reset() {
  usedFallback = false;
  reserveCalls = 0;
  releaseCalls = [];
  reserveHook = null;
  searchCalls = [];
  searchImpl = async () => [];
  streamEvents = [];
  streamError = null;
  capturedRequest = null;
  ownedTitles = [];
  storedModel = null;
}

afterEach(reset);

describe("recommendation stream orchestration", { concurrency: false }, () => {
  it("keeps burst candidates queued when the first match is rejected", async () => {
    ownedTitles = [
      {
        tmdbId: 99,
        mediaType: "MOVIE",
        name: "Owned Alias",
        releaseDate: new Date("2020-01-01T00:00:00.000Z"),
        deletedAt: null,
      },
      {
        tmdbId: 44,
        mediaType: "MOVIE",
        name: "Trashed Film",
        releaseDate: new Date("2004-01-01T00:00:00.000Z"),
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    streamEvents = [
      messageStart(),
      textEvent([modelRec("Owned Alias"), modelRec("Good Film"), modelRec("Spare Film")]),
    ];
    searchImpl = async (title) => [
      {
        id: title === "Owned Alias" ? 99 : title === "Good Film" ? 100 : 101,
        media_type: "movie",
        title,
        release_date: "2020-01-01",
        original_language: "en",
      },
    ];
    const emitted: StreamEvent[] = [];

    await runRecommendationStream("user-1", { count: 1 }, (event) => emitted.push(event));

    const recs = emitted.filter((event) => event.type === "rec");
    assert.equal(recs.length, 1);
    assert.equal((recs[0].rec as { title: string }).title, "Good Film");
    assert.deepEqual(searchCalls, ["Owned Alias", "Good Film"]);
    assert.match(JSON.stringify(capturedRequest), /Trashed Film/);
  });

  it("releases one shared slot when the stream throws before message_start", async () => {
    usedFallback = true;
    streamError = new Error("client failed before first event");
    const emitted: StreamEvent[] = [];

    await runRecommendationStream("user-1", { count: 1 }, (event) => emitted.push(event));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reserveCalls, 1);
    assert.deepEqual(releaseCalls, ["2026-09-05"]);
    assert.equal(emitted.at(-1)?.type, "error");
  });

  it("does not release a shared slot after message_start", async () => {
    usedFallback = true;
    streamEvents = [messageStart()];
    streamError = new Error("client failed after start");

    await runRecommendationStream("user-1", { count: 1 }, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reserveCalls, 1);
    assert.deepEqual(releaseCalls, []);
  });

  it("releases once when cancellation lands during reservation", async () => {
    usedFallback = true;
    const controller = new AbortController();
    reserveHook = () => controller.abort();

    await runRecommendationStream("user-1", { count: 1 }, () => {}, controller.signal);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(reserveCalls, 1);
    assert.deepEqual(releaseCalls, ["2026-09-05"]);
  });

  it("emits timer keep-alives during a pending lookup and stops unused searches", async () => {
    let resolveSearch: ((rows: SearchResult) => void) | null = null;
    searchImpl = (_title, signal) =>
      new Promise((resolve) => {
        resolveSearch = resolve;
        signal?.addEventListener("abort", () => resolve([]), { once: true });
      });
    streamEvents = [
      messageStart(),
      textEvent([modelRec("First"), modelRec("Second"), modelRec("Third")]),
    ];

    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    let timerId = 0;
    let clock = 0;
    globalThis.setTimeout = ((callback: () => void, delay = 0) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as typeof clearTimeout;

    const emitted: Array<{ at: number; event: StreamEvent }> = [];
    try {
      const run = runRecommendationStream("user-1", { count: 1 }, (event) => {
        emitted.push({ at: clock, event });
      });
      while (!resolveSearch) await Promise.resolve();

      for (let index = 0; index < 2; index++) {
        const next = [...timers.entries()].sort((a, b) => a[1].delay - b[1].delay)[0];
        assert.ok(next);
        timers.delete(next[0]);
        clock += next[1].delay;
        next[1].callback();
        await Promise.resolve();
      }

      const finishSearch = resolveSearch as unknown as (rows: SearchResult) => void;
      finishSearch([
        {
          id: 200,
          media_type: "movie",
          title: "First",
          release_date: "2020-01-01",
          original_language: "en",
        },
      ]);
      await run;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }

    const statuses = emitted.filter(({ event }) => event.type === "status");
    assert.deepEqual(statuses.map(({ at }) => at), [0, RECOMMEND_KEEPALIVE_MS, 20_000]);
    assert.ok(
      statuses.slice(1).every(({ at }, index) => at - statuses[index].at <= 10_000),
    );
    assert.ok(statuses.every(({ event }) => event.phase === "generating"));
    assert.deepEqual(searchCalls, ["First"]);
  });
});

describe("retired model ids", { concurrency: false }, () => {
  function requestedModel() {
    return (capturedRequest as { model: string }).model;
  }

  it("runs a saved Opus 5 preference on Opus 5.5", async () => {
    storedModel = "claude-opus-5";
    streamEvents = [messageStart()];
    await runRecommendationStream("user-1", { count: 1 }, () => {});
    assert.equal(requestedModel(), "claude-opus-5-5");
  });

  it("runs an unknown saved preference on the default model", async () => {
    storedModel = "gpt-9000";
    streamEvents = [messageStart()];
    await runRecommendationStream("user-1", { count: 1 }, () => {});
    assert.equal(requestedModel(), "claude-sonnet-5");
  });

  it("accepts an old id from a stale tab instead of rejecting the request", () => {
    assert.equal(recommendRequestSchema.parse({ model: "claude-opus-5" }).model, "claude-opus-5-5");
    assert.equal(recommendRequestSchema.parse({ model: "claude-haiku-4-5" }).model, "claude-haiku-4-5");
    assert.equal(recommendRequestSchema.parse({ model: "gpt-9000" }).model, "claude-sonnet-5");
    assert.equal(recommendRequestSchema.parse({}).model, undefined);
  });
});
