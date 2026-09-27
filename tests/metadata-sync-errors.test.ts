import assert from "node:assert/strict";
import { register } from "node:module";
import { afterEach, describe, it } from "node:test";

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-that-is-at-least-32-chars";
process.env.TMDB_ACCESS_TOKEN ??= "test-tmdb-token";

register(
  `data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  return nextResolve(specifier, context);
}
`)}`,
  import.meta.url,
);

const { prisma } = await import("../src/lib/prisma");
const { runScheduledSync, summarizeScheduledRun, syncUserMetadata } = await import(
  "../src/lib/metadata-sync"
);
const { TmdbError } = await import("../src/lib/tmdb");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Write = { where: Record<string, unknown>; data: Record<string, unknown> };
type Candidate = {
  id: string;
  tmdbId: number;
  mediaType: "MOVIE" | "TV";
  /** TV_METADATA candidates come from the metadata queue, the rest from the provider queue. */
  queue: "metadata" | "providers";
  metadataSyncState?: "OK" | "PARTIAL" | "FAILED" | null;
};

const REMOVED = "TMDB no longer lists this title. Use Change match to pick its current entry.";

const tmdbError = (status: number, code: number) =>
  // A tiny Retry-After keeps the one budgeted retry from sleeping 800 ms.
  Response.json(
    { success: false, status_code: code, status_message: "error" },
    { status, headers: { "retry-after": "0.001" } },
  );

/** Wire the candidate queries, title writes and TMDB to in-memory fakes. */
function stub(candidates: Candidate[], respond: (url: URL) => Response) {
  const requests: URL[] = [];
  const writes: Write[] = [];
  prisma.user.findUnique = (async () => ({ watchRegion: "US" })) as never;
  prisma.user.findMany = (async () => [{ id: "owner-e" }]) as never;
  prisma.title.findMany = (async (args: {
    where: { metadataSyncedAt?: unknown; providersSyncedAt?: unknown };
    select?: { providersSyncedAt?: boolean };
  }) => {
    const providerQuery = Boolean(args.select?.providersSyncedAt);
    const firstPage = providerQuery
      ? args.where.providersSyncedAt === null
      : args.where.metadataSyncedAt === null;
    if (!firstPage) return [];
    return candidates
      .filter((c) => (c.queue === "providers") === providerQuery)
      .map((c) => ({
        id: c.id,
        tmdbId: c.tmdbId,
        name: c.id,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        mediaType: c.mediaType,
        ...(providerQuery
          ? { providersSyncedAt: null, providersRegion: null }
          : { metadataSyncedAt: null, metadataSyncState: c.metadataSyncState ?? null, seasons: [] }),
      }));
  }) as never;
  prisma.title.updateMany = (async (args: Write) => {
    writes.push(args);
    return { count: 1 };
  }) as never;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  return { requests, writes };
}

const tv = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  tmdbId: 100,
  mediaType: "TV",
  queue: "metadata",
  ...over,
});

describe("TMDB error handling in the sync", { concurrency: false }, () => {
  it("aborts the run on a rejected token without stamping any title", async () => {
    const { requests, writes } = stub(
      [tv("a"), tv("b"), tv("c")],
      () => tmdbError(401, 7),
    );

    await assert.rejects(
      syncUserMetadata("owner-e", { limit: 3, concurrency: 1 }),
      (err: unknown) =>
        err instanceof TmdbError && err.status === 401 && err.code === 7,
    );
    assert.equal(requests.length, 1);
    assert.equal(writes.length, 0);
  });

  it("reports a rejected token once, as the account's run error", async () => {
    stub([tv("a"), tv("b")], () => tmdbError(401, 7));

    const run = await runScheduledSync();
    assert.equal(run.users.length, 1);
    assert.match(run.users[0].runError ?? "", /TMDB 401 \(code 7\)/);
    assert.equal(run.users[0].failed, 0);
    assert.equal(summarizeScheduledRun(run).totalFailure, true);
  });

  it("aborts rather than saving a partial show when a season request is rejected", async () => {
    const { writes } = stub([tv("a")], (url) =>
      url.searchParams.get("append_to_response") === "watch/providers"
        ? Response.json({
            id: 100,
            status: "Returning Series",
            seasons: [{ id: 501, season_number: 1, episode_count: 1, air_date: "2026-01-01" }],
            "watch/providers": { results: {} },
          })
        : tmdbError(401, 7),
    );

    await assert.rejects(syncUserMetadata("owner-e", { limit: 1 }), TmdbError);
    assert.equal(writes.length, 0);
  });

  it("records a removed show with copy the owner can act on", async () => {
    const { writes } = stub([tv("a")], () => tmdbError(404, 34));

    const result = await syncUserMetadata("owner-e", { limit: 1 });
    assert.equal(result.failed, 1);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].data.metadataSyncState, "FAILED");
    assert.equal(writes[0].data.metadataLastError, REMOVED);
    // Stamped: it goes to the back of the queue instead of failing first every night.
    assert.ok(writes[0].data.metadataSyncedAt instanceof Date);
  });

  it("keeps a first transient failure at the head of the queue, visibly", async () => {
    const { requests, writes } = stub([tv("a")], () => tmdbError(503, 9));

    const result = await syncUserMetadata("owner-e", { limit: 1 });
    assert.equal(requests.length, 2, "the 503 is retried once before failing");
    assert.equal(result.failed, 1);
    assert.equal(writes[0].data.metadataSyncState, "FAILED");
    assert.match(String(writes[0].data.metadataLastError), /TMDB 503 \(code 9\)/);
    assert.equal("metadataSyncedAt" in writes[0].data, false);
  });

  it("stamps a transient failure when the title had already failed", async () => {
    const { writes } = stub([tv("a", { metadataSyncState: "FAILED" })], () =>
      tmdbError(429, 25),
    );

    await syncUserMetadata("owner-e", { limit: 1 });
    assert.ok(writes[0].data.metadataSyncedAt instanceof Date);
  });

  it("records a removed movie, then clears it once TMDB lists it again", async () => {
    const movie: Candidate = { id: "m", tmdbId: 77, mediaType: "MOVIE", queue: "providers" };
    const removed = stub([movie], () => tmdbError(404, 34));

    await syncUserMetadata("owner-e", { limit: 1 });
    assert.equal(removed.writes[0].data.metadataSyncState, "FAILED");
    assert.equal(removed.writes[0].data.metadataLastError, REMOVED);
    assert.ok(removed.writes[0].data.providersSyncedAt instanceof Date);

    const restored = stub([movie], () =>
      Response.json({ id: 77, "watch/providers": { results: {} } }),
    );
    await syncUserMetadata("owner-e", { limit: 1 });
    assert.equal(restored.writes[0].data.metadataSyncState, null);
    assert.equal(restored.writes[0].data.metadataLastError, null);
  });

  it("keeps stamping a provider attempt that failed for another reason", async () => {
    const movie: Candidate = { id: "m", tmdbId: 77, mediaType: "MOVIE", queue: "providers" };
    const { writes } = stub([movie], () => tmdbError(503, 9));

    await syncUserMetadata("owner-e", { limit: 1 });
    assert.ok(writes[0].data.providersSyncedAt instanceof Date);
    assert.equal("metadataSyncState" in writes[0].data, false);
  });
});
