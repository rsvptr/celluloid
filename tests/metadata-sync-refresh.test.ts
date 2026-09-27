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
const { syncUserMetadata } = await import("../src/lib/metadata-sync");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Write = { where: Record<string, unknown>; data: Record<string, unknown> };

/** Sync one title that is due only for a provider refresh. No database is touched. */
async function syncProviderCandidate(
  mediaType: "MOVIE" | "TV",
  tmdbId: number,
  detail: Record<string, unknown>,
) {
  const requests: URL[] = [];
  const writes: Write[] = [];
  prisma.user.findUnique = (async () => ({ watchRegion: "US" })) as never;
  prisma.title.findMany = (async (args: { select?: { providersSyncedAt?: boolean } }) =>
    args.select?.providersSyncedAt
      ? [
          {
            id: "title-p",
            tmdbId,
            name: "Title",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            mediaType,
            providersSyncedAt: null,
            providersRegion: null,
          },
        ]
      : []) as never;
  prisma.title.updateMany = (async (args: Write) => {
    writes.push(args);
    return { count: 1 };
  }) as never;
  globalThis.fetch = (async (input: string | URL | Request) => {
    requests.push(new URL(String(input)));
    return Response.json(detail);
  }) as typeof fetch;

  const result = await syncUserMetadata("owner-p", { limit: 1 });
  return { result, requests, writes };
}

describe("provider-path metadata refresh", { concurrency: false }, () => {
  it("refreshes a movie's metadata on the same single request as its providers", async () => {
    const { result, requests, writes } = await syncProviderCandidate("MOVIE", 77, {
      id: 77,
      status: "Released",
      overview: "Now with a synopsis.",
      poster_path: "/poster.jpg",
      backdrop_path: null,
      vote_average: 6.8,
      genres: [{ name: "Thriller" }],
      release_date: "2026-12-04",
      runtime: 0,
      "watch/providers": {
        results: {
          US: { flatrate: [{ provider_id: 8, provider_name: "Netflix", logo_path: null }] },
        },
      },
    });

    assert.equal(result.synced, 1);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].pathname, "/3/movie/77");
    assert.equal(requests[0].searchParams.get("append_to_response"), "watch/providers");
    assert.equal(requests[0].searchParams.get("language"), "en-US");

    assert.equal(writes.length, 1);
    const { where, data } = writes[0];
    assert.equal(where.tmdbId, 77);
    assert.equal(where.mediaType, "MOVIE");
    assert.equal(data.overview, "Now with a synopsis.");
    assert.equal(data.posterPath, "/poster.jpg");
    assert.equal(data.tmdbRating, 6.8);
    assert.deepEqual(data.genres, ["Thriller"]);
    assert.equal((data.releaseDate as Date).toISOString(), "2026-12-04T00:00:00.000Z");
    assert.equal("backdropPath" in data, false);
    assert.equal("runtime" in data, false);
    assert.equal("tmdbStatus" in data, false);
    assert.deepEqual(data.streamProviderIds, [8]);
    assert.equal(data.providersRegion, "US");
    assert.ok(data.providersSyncedAt instanceof Date);
  });

  it("records a TV show's status but leaves its next air date and runtime alone", async () => {
    const { result, requests, writes } = await syncProviderCandidate("TV", 88, {
      id: 88,
      status: "Returning Series",
      next_episode_to_air: null,
      episode_run_time: [],
      "watch/providers": { results: {} },
    });

    assert.equal(result.synced, 1);
    assert.equal(requests[0].pathname, "/3/tv/88");
    const { data } = writes[0];
    assert.equal(data.tmdbStatus, "Returning Series");
    assert.equal("nextEpisodeAirDate" in data, false);
    assert.equal("runtime" in data, false);
    assert.deepEqual(data.streamProviderIds, []);
  });
});
