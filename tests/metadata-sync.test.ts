import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { newEpisodeDiscoveredAfter } from "../src/lib/data";
import type { TmdbSeasonDetails } from "../src/lib/tmdb";

// metadata-sync.ts is server code. Next resolves this marker to a no-op under
// its react-server condition; plain node --test needs the same condition added
// before the module is dynamically imported. No database operation is invoked.
process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";
const serverOnlyShim = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(serverOnlyShim)}`, import.meta.url);

const {
  deriveNextEpisodeAirDate,
  discoveredAtForNewEpisode,
  streamProviderIdsForRegion,
  summarizeScheduledRun,
  tallySyncOutcomes,
} = await import("../src/lib/metadata-sync");
type SyncRunResult = import("../src/lib/metadata-sync").SyncRunResult;

const DAY_MS = 24 * 60 * 60 * 1000;

function episodeBadgeWouldFire(
  airDate: Date,
  discoveredAt: Date,
  titleCreatedAt: Date,
  now: Date,
): boolean {
  return (
    airDate <= now &&
    discoveredAt > newEpisodeDiscoveredAfter(now) &&
    discoveredAt > new Date(titleCreatedAt.getTime() + 60_000)
  );
}

function seasonWithAirDates(...airDates: Array<string | null>): TmdbSeasonDetails {
  return {
    id: 100,
    season_number: 1,
    name: "Season 1",
    overview: "",
    air_date: airDates[0] ?? null,
    poster_path: null,
    episodes: airDates.map((airDate, index) => ({
      id: 200 + index,
      episode_number: index + 1,
      season_number: 1,
      name: `Episode ${index + 1}`,
      overview: "",
      air_date: airDate,
      runtime: 45,
      still_path: null,
      vote_average: 0,
    })),
  };
}

describe("discoveredAtForNewEpisode", () => {
  it("dates an advance-published episode to air day so the badge activates then", () => {
    const titleCreatedAt = new Date("2026-07-01T12:00:00.000Z");
    const firstSeenAt = new Date("2026-08-01T12:00:00.000Z");
    const airDate = new Date("2026-09-01T00:00:00.000Z");
    const discoveredAt = discoveredAtForNewEpisode(airDate, titleCreatedAt, firstSeenAt);

    assert.equal(discoveredAt.toISOString(), airDate.toISOString());
    assert.equal(
      episodeBadgeWouldFire(
        airDate,
        discoveredAt,
        titleCreatedAt,
        new Date("2026-08-31T23:59:59.999Z"),
      ),
      false,
    );
    assert.equal(
      episodeBadgeWouldFire(
        airDate,
        discoveredAt,
        titleCreatedAt,
        new Date("2026-09-01T12:00:00.000Z"),
      ),
      true,
    );
  });

  it("uses the sync time for a recent aired episode and one with no air date", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const titleCreatedAt = new Date("2025-01-01T00:00:00.000Z");
    const recentAirDate = new Date(now.getTime() - 10 * DAY_MS);

    assert.equal(
      discoveredAtForNewEpisode(recentAirDate, titleCreatedAt, now).toISOString(),
      now.toISOString(),
    );
    assert.equal(
      discoveredAtForNewEpisode(null, titleCreatedAt, now).toISOString(),
      now.toISOString(),
    );
  });

  it("keeps the 30-day boundary recent and dates older back catalogue to the title", () => {
    const now = new Date("2026-08-03T12:00:00.000Z");
    const titleCreatedAt = new Date("2024-04-05T00:00:00.000Z");
    const boundary = new Date(now.getTime() - 30 * DAY_MS);
    const older = new Date(boundary.getTime() - 1);

    assert.equal(
      discoveredAtForNewEpisode(boundary, titleCreatedAt, now).toISOString(),
      now.toISOString(),
    );
    assert.equal(
      discoveredAtForNewEpisode(older, titleCreatedAt, now).toISOString(),
      titleCreatedAt.toISOString(),
    );
  });
});

describe("new-episode badge window", () => {
  it("uses the migration cutoff until the rolling 14-day window overtakes it", () => {
    assert.equal(
      newEpisodeDiscoveredAfter(new Date("2026-07-25T00:00:00.000Z")).toISOString(),
      "2026-07-18T00:00:00.000Z",
    );
    assert.equal(
      newEpisodeDiscoveredAfter(new Date("2026-08-04T00:00:00.000Z")).toISOString(),
      "2026-07-21T00:00:00.000Z",
    );
  });
});

describe("deriveNextEpisodeAirDate", () => {
  it("prefers TMDB's current or future next-episode date", () => {
    const next = deriveNextEpisodeAirDate(
      "2026-08-20",
      [seasonWithAirDates("2026-08-10")],
      new Date("2026-08-03T18:00:00.000Z"),
    );
    assert.equal(next?.toISOString(), "2026-08-20T00:00:00.000Z");
  });

  it("falls back to the earliest non-past season date and otherwise clears", () => {
    const now = new Date("2026-08-03T18:00:00.000Z");
    const next = deriveNextEpisodeAirDate(
      "2026-08-02",
      [seasonWithAirDates("2026-08-12", "2026-08-03", null, "2026-08-07")],
      now,
    );

    assert.equal(next?.toISOString(), "2026-08-03T00:00:00.000Z");
    assert.equal(
      deriveNextEpisodeAirDate(
        "2026-08-02",
        [seasonWithAirDates("2026-08-01")],
        now,
      ),
      null,
    );
  });
});

describe("streamProviderIdsForRegion", () => {
  it("dedupes included provider groups and excludes rent, buy, and other regions", () => {
    const ids = streamProviderIdsForRegion(
      {
        GB: {
          flatrate: [
            { provider_id: 9, provider_name: "Nine", logo_path: null },
            { provider_id: 2, provider_name: "Two", logo_path: null },
          ],
          free: [{ provider_id: 9, provider_name: "Nine", logo_path: null }],
          ads: [{ provider_id: 5, provider_name: "Five", logo_path: null }],
          rent: [{ provider_id: 7, provider_name: "Seven", logo_path: null }],
          buy: [{ provider_id: 8, provider_name: "Eight", logo_path: null }],
        },
        US: {
          flatrate: [{ provider_id: 1, provider_name: "One", logo_path: null }],
        },
      },
      "GB",
    );

    assert.deepEqual(ids, [2, 5, 9]);
    assert.deepEqual(streamProviderIdsForRegion(undefined, "GB"), []);
    assert.deepEqual(streamProviderIdsForRegion({}, "GB"), []);
  });
});

describe("tallySyncOutcomes", () => {
  it("accounts for every considered title, including vanished and budget-skipped rows", () => {
    const result = tallySyncOutcomes("owner", 5, [
      { titleId: "ok", name: "OK", state: "OK", newEpisodes: 2 },
      { titleId: "partial", name: "Partial", state: "PARTIAL", newEpisodes: 1 },
      { titleId: "failed", name: "Failed", state: "FAILED", newEpisodes: 0 },
      { titleId: "vanished", name: "Vanished", state: "VANISHED", newEpisodes: 0 },
      null,
    ]);

    assert.deepEqual(result, {
      userId: "owner",
      considered: 5,
      synced: 2,
      failed: 1,
      skipped: 2,
      newEpisodes: 3,
    });
    assert.equal(result.synced + result.failed + result.skipped, result.considered);
  });
});

// --- scheduled-run health verdict (CEL-17 / AUD-OPS-04) ----------------------

describe("summarizeScheduledRun", () => {
  const user = (over: Partial<SyncRunResult> = {}): SyncRunResult => ({
    userId: "u1",
    considered: 5,
    synced: 5,
    failed: 0,
    skipped: 0,
    newEpisodes: 0,
    ...over,
  });
  const run = (users: SyncRunResult[]) => ({
    startedAt: "2026-08-04T00:00:00.000Z",
    durationMs: 1000,
    users,
  });

  it("reads a healthy run as neither degraded nor failed", () => {
    assert.deepEqual(summarizeScheduledRun(run([user()])), {
      totalFailure: false,
      degraded: false,
    });
  });

  it("treats an account with nothing to do as healthy, not vacuously failed", () => {
    const verdict = summarizeScheduledRun(run([user({ considered: 0, synced: 0 })]));
    assert.equal(verdict.totalFailure, false);
    assert.equal(verdict.degraded, false);
  });

  it("flags total failure when every account failed", () => {
    const verdict = summarizeScheduledRun(
      run([
        user({ synced: 0, failed: 5 }),
        user({ userId: "u2", considered: 0, synced: 0, runError: "db down" }),
      ]),
    );
    assert.deepEqual(verdict, { totalFailure: true, degraded: true });
  });

  it("keeps a partly-failed run degraded but not failed", () => {
    const verdict = summarizeScheduledRun(
      run([user({ failed: 2, synced: 3 }), user({ userId: "u2" })]),
    );
    assert.deepEqual(verdict, { totalFailure: false, degraded: true });
  });

  it("reads an empty deployment as healthy", () => {
    assert.deepEqual(summarizeScheduledRun(run([])), {
      totalFailure: false,
      degraded: false,
    });
  });
});
