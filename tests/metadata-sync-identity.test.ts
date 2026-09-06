import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { describe, it } from "node:test";

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

type LocalEpisode = {
  id: string;
  episodeNumber: number;
  tmdbId: number | null;
  name: string;
  overview: string | null;
  airDate: Date | null;
  runtime: number | null;
  stillPath: string | null;
  watched: boolean;
  withdrawnAt: Date | null;
  discoveredAt: Date;
};

type RemoteEpisode = {
  id: number;
  episode_number: number;
  name: string;
  air_date: string | null;
};

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function localEpisode(
  episodeNumber: number,
  tmdbId: number,
  name: string,
  watched = false,
  withdrawnAt: Date | null = null,
): LocalEpisode {
  return {
    id: `row-${tmdbId}`,
    episodeNumber,
    tmdbId,
    name,
    overview: null,
    airDate: date("2026-08-01"),
    runtime: 45,
    stillPath: null,
    watched,
    withdrawnAt,
    discoveredAt: date("2026-01-01"),
  };
}

async function runSyncScenario(options: {
  localEpisodes: LocalEpisode[];
  remoteEpisodes: RemoteEpisode[];
  mutateIdentityBeforeLock?: boolean;
  failAfterIdentityChange?: boolean;
  enforceEpisodeConstraints?: boolean;
}) {
  const title = {
    id: "title-a",
    userId: "owner-a",
    tmdbId: 100,
    mediaType: "TV",
    name: "Old series",
    createdAt: date("2026-01-01"),
    totalEpisodes: options.localEpisodes.filter((episode) => episode.withdrawnAt === null).length,
    watchedEpisodes: options.localEpisodes.filter(
      (episode) => episode.withdrawnAt === null && episode.watched,
    ).length,
    metadataSyncedAt: null,
    providersRegion: null,
    seasons: [
      {
        seasonNumber: 1,
        episodeCount: options.localEpisodes.length,
        airDate: date("2026-01-01"),
      },
    ],
  };
  const season = {
    id: "season-1",
    seasonNumber: 1,
    tmdbId: 500,
    name: "Season 1",
    overview: null,
    airDate: date("2026-01-01"),
    posterPath: null,
    episodeCount: options.localEpisodes.length,
    episodes: options.localEpisodes.map((episode) => ({ ...episode })),
  };
  const writes: string[] = [];
  let titleWrite: Record<string, unknown> | null = null;

  prisma.user.findUnique = (async () => ({ watchRegion: "US" })) as never;
  prisma.title.findMany = (async (args: { select?: { providersSyncedAt?: boolean } }) =>
    args.select?.providersSyncedAt ? [] : [{ ...title }]) as never;
  prisma.title.updateMany = (async ({
    where,
    data,
  }: {
    where: { id: string; userId: string; tmdbId?: number; mediaType?: string };
    data: Record<string, unknown>;
  }) => {
    const matches =
      where.id === title.id &&
      where.userId === title.userId &&
      (where.tmdbId === undefined || where.tmdbId === title.tmdbId) &&
      (where.mediaType === undefined || where.mediaType === title.mediaType);
    if (matches) Object.assign(title, data);
    return { count: matches ? 1 : 0 };
  }) as never;
  prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        const [id, userId, tmdbId, mediaType] = values;
        const current = title as typeof title & { deletedAt?: Date | null };
        return id === current.id &&
          userId === current.userId &&
          tmdbId === current.tmdbId &&
          mediaType === current.mediaType &&
          !current.deletedAt
          ? [{ id: current.id }]
          : [];
      },
      season: {
        findMany: async () => [season],
        create: async () => {
          throw new Error("unexpected season create");
        },
        update: async ({ data }: { data: Record<string, unknown> }) => {
          writes.push("season.update");
          Object.assign(season, data);
        },
      },
      episode: {
        update: async ({ where, data }: { where: { id: string }; data: Partial<LocalEpisode> }) => {
          const row = season.episodes.find((episode) => episode.id === where.id);
          assert.ok(row);
          if (options.enforceEpisodeConstraints) {
            const next = { ...row, ...data };
            assert.ok(next.episodeNumber >= 0, "episodeNumber CHECK rejected a negative write");
            assert.ok(
              next.withdrawnAt === null || next.withdrawnAt instanceof Date,
              "withdrawnAt must be null or a Date",
            );
            assert.equal(
              season.episodes.some(
                (episode) =>
                  episode.id !== where.id &&
                  episode.episodeNumber === next.episodeNumber,
              ),
              false,
              "season/episodeNumber unique rejected a colliding write",
            );
          }
          writes.push(`episode.update:${where.id}:${String(data.episodeNumber ?? "metadata")}`);
          Object.assign(row, data);
        },
        delete: async ({ where }: { where: { id: string } }) => {
          const index = season.episodes.findIndex((episode) => episode.id === where.id);
          assert.notEqual(index, -1);
          writes.push(`episode.delete:${where.id}`);
          season.episodes.splice(index, 1);
        },
        createMany: async ({
          data,
        }: {
          data: Array<Partial<LocalEpisode> & Pick<LocalEpisode, "tmdbId" | "episodeNumber">>;
        }) => {
          for (const episode of data) {
            if (options.enforceEpisodeConstraints) {
              assert.ok(episode.episodeNumber >= 0, "episodeNumber CHECK rejected a negative write");
              assert.ok(
                episode.withdrawnAt === null || episode.withdrawnAt instanceof Date,
                "withdrawnAt must be null or a Date",
              );
              assert.equal(
                season.episodes.some(
                  (current) => current.episodeNumber === episode.episodeNumber,
                ),
                false,
                "season/episodeNumber unique rejected a colliding write",
              );
            }
            season.episodes.push({
              ...episode,
              id: `created-${episode.tmdbId}`,
              watched: episode.watched ?? false,
            } as LocalEpisode);
          }
          writes.push(`episode.createMany:${data.length}`);
          return { count: data.length };
        },
        count: async ({ where }: { where: { watched?: boolean; withdrawnAt?: null } }) =>
          season.episodes.filter(
            (episode) =>
              (where.withdrawnAt !== null || episode.withdrawnAt === null) &&
              (where.watched === undefined || episode.watched === where.watched),
          ).length,
      },
      title: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          titleWrite = data;
          Object.assign(title, data);
        },
      },
    })) as never;

  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === "/3/tv/100") {
      if (options.failAfterIdentityChange) {
        Object.assign(title, { tmdbId: 200, mediaType: "MOVIE", name: "New movie" });
        throw new Error("old request failed after rematch");
      }
      return Response.json({
        id: 100,
        status: "Returning Series",
        number_of_seasons: 1,
        next_episode_to_air: null,
        seasons: [
          {
            season_number: 1,
            episode_count: options.remoteEpisodes.length,
            air_date: "2026-01-01",
          },
        ],
      });
    }
    if (path === "/3/tv/100/season/1") {
      if (options.mutateIdentityBeforeLock) {
        Object.assign(title, { tmdbId: 200, mediaType: "MOVIE", name: "New movie" });
      }
      return Response.json({
        id: 500,
        season_number: 1,
        name: "Season 1",
        overview: null,
        air_date: "2026-01-01",
        poster_path: null,
        episodes: options.remoteEpisodes.map((episode) => ({
          ...episode,
          overview: null,
          runtime: 45,
          still_path: null,
        })),
      });
    }
    throw new Error(`Unexpected synthetic fetch ${path}`);
  }) as typeof fetch;

  const result = await syncUserMetadata("owner-a", { limit: 1 });
  return { result, title, season, writes, titleWrite };
}

describe("TMDB episode identity sync", { concurrency: false }, () => {
  it("moves the watched tick with a TMDB id through a coordinate shift", async () => {
    const scenario = await runSyncScenario({
      enforceEpisodeConstraints: true,
      localEpisodes: [
        localEpisode(1, 1001, "Pilot", true),
        localEpisode(2, 1002, "Second"),
      ],
      remoteEpisodes: [
        { id: 1000, episode_number: 1, name: "Special", air_date: "2026-07-25" },
        { id: 1001, episode_number: 2, name: "Pilot", air_date: "2026-08-01" },
        { id: 1002, episode_number: 3, name: "Second", air_date: "2026-08-08" },
      ],
    });

    const pilot = scenario.season.episodes.find((episode) => episode.tmdbId === 1001);
    const special = scenario.season.episodes.find((episode) => episode.tmdbId === 1000);
    assert.equal(pilot?.episodeNumber, 2);
    assert.equal(pilot?.watched, true);
    assert.equal(special?.episodeNumber, 1);
    assert.equal(special?.watched, false);
    assert.equal(scenario.title.totalEpisodes, 3);
    assert.equal(scenario.title.watchedEpisodes, 1);
    assert.ok(
      scenario.writes.some((write) => write === "episode.update:row-1001:1000001"),
    );
  });

  it("retains a withdrawn watched row but excludes it from progress totals", async () => {
    const scenario = await runSyncScenario({
      enforceEpisodeConstraints: true,
      localEpisodes: [
        localEpisode(1, 1001, "Pilot", true),
        localEpisode(2, 1002, "Withdrawn", true),
        localEpisode(3, 1003, "Unwatched withdrawal"),
      ],
      remoteEpisodes: [
        { id: 1001, episode_number: 1, name: "Pilot", air_date: "2026-08-01" },
      ],
    });

    const watchedWithdrawal = scenario.season.episodes.find(
      (episode) => episode.tmdbId === 1002,
    );
    assert.ok(watchedWithdrawal);
    assert.equal(watchedWithdrawal.watched, true);
    assert.equal(watchedWithdrawal.episodeNumber, 2);
    assert.equal(watchedWithdrawal.airDate?.toISOString(), date("2026-08-01").toISOString());
    assert.ok(watchedWithdrawal.withdrawnAt instanceof Date);
    assert.equal(
      scenario.season.episodes.some((episode) => episode.tmdbId === 1003),
      false,
    );
    assert.equal(scenario.title.totalEpisodes, 1);
    assert.equal(scenario.title.watchedEpisodes, 1);
  });

  it("parks a withdrawn row when another TMDB id takes its coordinate", async () => {
    const withdrawnAt = date("2026-08-15");
    const scenario = await runSyncScenario({
      enforceEpisodeConstraints: true,
      localEpisodes: [
        localEpisode(1, 1001, "Withdrawn pilot", true, withdrawnAt),
        localEpisode(2, 1002, "Replacement"),
      ],
      remoteEpisodes: [
        { id: 1002, episode_number: 1, name: "Replacement", air_date: "2026-08-08" },
      ],
    });

    const withdrawn = scenario.season.episodes.find((episode) => episode.tmdbId === 1001);
    const replacement = scenario.season.episodes.find((episode) => episode.tmdbId === 1002);
    assert.equal(withdrawn?.episodeNumber, 2_000_001);
    assert.equal(withdrawn?.withdrawnAt, withdrawnAt);
    assert.equal(withdrawn?.watched, true);
    assert.equal(replacement?.episodeNumber, 1);
    assert.equal(replacement?.withdrawnAt, null);
    assert.equal(scenario.title.totalEpisodes, 1);
    assert.equal(scenario.title.watchedEpisodes, 0);
  });

  it("revives a withdrawn row when its TMDB id reappears", async () => {
    const scenario = await runSyncScenario({
      enforceEpisodeConstraints: true,
      localEpisodes: [
        localEpisode(2_000_001, 1001, "Pilot", true, date("2026-08-15")),
      ],
      remoteEpisodes: [
        { id: 1001, episode_number: 1, name: "Pilot", air_date: "2026-08-01" },
      ],
    });

    const pilot = scenario.season.episodes.find((episode) => episode.tmdbId === 1001);
    assert.equal(pilot?.episodeNumber, 1);
    assert.equal(pilot?.withdrawnAt, null);
    assert.equal(pilot?.watched, true);
    assert.equal(scenario.title.totalEpisodes, 1);
    assert.equal(scenario.title.watchedEpisodes, 1);
  });

  it("discards a stale response when the title identity changes before its lock", async () => {
    const scenario = await runSyncScenario({
      localEpisodes: [],
      remoteEpisodes: [
        { id: 1001, episode_number: 1, name: "Old episode", air_date: "2026-08-01" },
      ],
      mutateIdentityBeforeLock: true,
    });

    assert.equal(scenario.result.skipped, 1);
    assert.equal(scenario.title.tmdbId, 200);
    assert.equal(scenario.title.mediaType, "MOVIE");
    assert.equal(scenario.writes.length, 0);
    assert.equal(scenario.titleWrite, null);
  });

  it("does not stamp a rematched title FAILED when an old request rejects", async () => {
    const scenario = await runSyncScenario({
      localEpisodes: [],
      remoteEpisodes: [],
      failAfterIdentityChange: true,
    });

    assert.equal(scenario.result.skipped, 1);
    assert.equal(scenario.result.failed, 0);
    assert.equal(scenario.title.tmdbId, 200);
    assert.equal(scenario.title.mediaType, "MOVIE");
    assert.equal("metadataSyncState" in scenario.title, false);
  });

  it("uses the active-episode marker in badge and Upcoming SQL", async () => {
    const [dataSource, upcomingSource] = await Promise.all([
      readFile(new URL("../src/lib/data.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/app/(app)/upcoming/data.ts", import.meta.url), "utf8"),
    ]);

    assert.match(dataSource, /e\."withdrawnAt" IS NULL/);
    assert.match(upcomingSource, /e\."withdrawnAt" IS NULL/);
    assert.match(dataSource, /where: ACTIVE_EPISODE_FILTER/);
  });
});
