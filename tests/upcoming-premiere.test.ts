import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

const DAY_MS = 86_400_000;
const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
const inThreeDays = new Date(today.getTime() + 3 * DAY_MS);
const inFiveDays = new Date(today.getTime() + 5 * DAY_MS);

const episodeQueries: unknown[] = [];
const show = (id: string, nextEpisodeAirDate: Date) => ({
  id,
  name: `Show ${id}`,
  posterPath: null,
  status: "WATCHING",
  nextEpisodeAirDate,
  tmdbStatus: "Returning Series",
  totalEpisodes: 10,
  watchedEpisodes: 10,
});

Object.assign(globalThis, {
  __CELLULOID_UPCOMING_PREMIERE_PRISMA__: {
    user: {
      findUnique: async () => ({ timeZone: "UTC", watchRegion: "US", myProviders: [], lastBackupAt: null }),
    },
    title: {
      aggregate: async () => ({ _count: { _all: 2 }, _max: { metadataSyncedAt: null } }),
      findMany: async () => [show("opener", inThreeDays), show("midseason", inFiveDays)],
    },
    episode: {
      findMany: async (query: unknown) => {
        episodeQueries.push(query);
        // "opener" has its season's episode 1 on its next air date; the other
        // show's first episode aired long ago, on no date in the window.
        return [{ airDate: inThreeDays, season: { titleId: "opener" } }];
      },
    },
    $queryRaw: async () => [],
  },
});

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const prisma = globalThis.__CELLULOID_UPCOMING_PREMIERE_PRISMA__;",
      ),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { getUpcoming } = await import("../src/app/(app)/upcoming/data");

describe("Airing premiere label", () => {
  it("marks a show whose next episode opens a season, from stored episodes only", async () => {
    const { groups } = await getUpcoming("user-1");
    const entries = groups.flatMap((group) => group.entries);
    assert.deepEqual(
      entries.map((entry) => [entry.id, entry.premiere]),
      [
        ["opener", true],
        ["midseason", false],
      ],
    );

    // One query for the owner's live, undropped shows' season openers in the
    // window, withdrawn rows and specials left out.
    assert.equal(episodeQueries.length, 1);
    const { where } = episodeQueries[0] as { where: Record<string, unknown> };
    assert.equal(where.episodeNumber, 1);
    assert.equal(where.withdrawnAt, null);
    assert.deepEqual(where.season, {
      seasonNumber: { gte: 1 },
      title: {
        userId: "user-1",
        deletedAt: null,
        mediaType: "TV",
        status: { not: "DROPPED" },
      },
    });
  });
});
