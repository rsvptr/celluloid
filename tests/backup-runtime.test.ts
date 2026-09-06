import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";
import type { BackupEnvelope, BackupSuppression, BackupTitle } from "../src/lib/backup-format";
import type { BackupRestorePlan } from "../src/lib/backup";

const stamp = "2026-08-04T08:00:00.000Z";

type UserState = {
  timeZone: string;
  watchRegion: string;
  myProviders: number[];
  recommendModel: string | null;
};

type SuppressionState = Omit<BackupSuppression, "sourceId" | "createdAt"> & {
  id: string;
  userId: string;
  createdAt: Date;
};

type WatchEventState = {
  id: string;
  userId: string;
  titleId: string;
  episodeId: string | null;
  kind: "TITLE_COMPLETED" | "EPISODE_WATCHED" | "REWATCH";
  occurredAt: Date;
  source: "MANUAL" | "BULK" | "IMPORT" | "RESTORE" | "BACKFILL";
  note: string | null;
  createdAt: Date;
};

type ShareState = {
  id: string;
  slug: string;
  userId: string;
  name: string | null;
  titleIds: string[];
  includeNotes: boolean;
  includeWatchlist: boolean;
  scope: "WHOLE_LIBRARY" | "SELECTION";
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  items: Array<{ titleId: string; position: number }>;
};

function emptyEnvelope(user: BackupEnvelope["user"]): BackupEnvelope {
  return {
    app: "celluloid",
    schemaVersion: 2,
    exportedAt: stamp,
    user,
    titles: [],
    tags: [],
    shares: [],
    watchEvents: [],
    suppressions: [],
  };
}

function previewCounts(overrides: Partial<BackupRestorePlan["counts"]> = {}) {
  return {
    create: 0,
    update: 0,
    skip: 0,
    conflict: 0,
    eventsCreate: 0,
    suppressionsCreate: 0,
    suppressionsUpdate: 0,
    suppressionsSkip: 0,
    providerSelections: 0,
    providerPreferenceIncluded: 0,
    providerPreferenceUpdate: 0,
    recommendModelPreferenceIncluded: 0,
    recommendModelPreferenceUpdate: 0,
    ...overrides,
  };
}

class FakeBackupDb {
  user: UserState = {
    timeZone: "UTC",
    watchRegion: "US",
    myProviders: [],
    recommendModel: null,
  };
  suppressions: SuppressionState[] = [];
  watchEvents: WatchEventState[] = [];
  shares: ShareState[] = [];
  exportTitles: Array<Record<string, unknown>> = [];
  restoreTitle: Record<string, unknown> | null = null;
  titleUpdates: Array<Record<string, unknown>> = [];
  transactionOptions: Array<Record<string, unknown> | undefined> = [];
  watchEventFindManyCalls = 0;
  watchEventCreateManyCalls = 0;

  private readonly tx = {
    $queryRaw: async () => (this.restoreTitle ? [{ id: this.restoreTitle.id }] : []),
    user: {
      findUnique: async () => ({ ...this.user, myProviders: [...this.user.myProviders] }),
      update: async ({ data }: { data: Partial<UserState> }) => {
        this.user = {
          ...this.user,
          ...data,
          myProviders: data.myProviders ? [...data.myProviders] : this.user.myProviders,
        };
        return { id: "user-1" };
      },
    },
    title: {
      findMany: async () => this.exportTitles,
      findUnique: async () => this.restoreTitle,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        this.titleUpdates.push(data);
        if (this.restoreTitle) Object.assign(this.restoreTitle, data);
        return { id: "local-tv" };
      },
    },
    tag: { findMany: async () => [] },
    shareList: {
      findMany: async ({ where }: { where: Partial<ShareState> }) =>
        this.shares.filter((share) =>
          Object.entries(where).every(([key, value]) => {
            const current = share[key as keyof ShareState];
            if (current instanceof Date && value instanceof Date) {
              return current.getTime() === value.getTime();
            }
            return current === value;
          }),
        ),
      findUnique: async ({ where }: { where: { id?: string; slug?: string } }) =>
        this.shares.find(
          (share) => share.id === where.id || share.slug === where.slug,
        ) ?? null,
      create: async ({ data }: { data: Omit<ShareState, "id" | "items"> & { id?: string } }) => {
        const created: ShareState = {
          ...data,
          id: data.id ?? `generated-share-${this.shares.length + 1}`,
          titleIds: data.titleIds ?? [],
          items: [],
        };
        this.shares.push(created);
        return { id: created.id };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ShareState> }) => {
        const share = this.shares.find((candidate) => candidate.id === where.id);
        if (!share) throw new Error("missing fake share");
        Object.assign(share, data);
        return share;
      },
    },
    shareListItem: {
      deleteMany: async ({ where }: { where: { shareListId: string } }) => {
        const share = this.shares.find((candidate) => candidate.id === where.shareListId);
        if (share) share.items = [];
        return { count: 0 };
      },
      createMany: async ({ data }: { data: Array<{ shareListId: string; titleId: string; position: number }> }) => {
        for (const item of data) {
          const share = this.shares.find((candidate) => candidate.id === item.shareListId);
          if (share) share.items.push({ titleId: item.titleId, position: item.position });
        }
        return { count: data.length };
      },
    },
    watchEvent: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        this.watchEventFindManyCalls += 1;
        const clauses = where?.OR as Array<Partial<WatchEventState>> | undefined;
        if (clauses) {
          return this.watchEvents.filter(
            (row) =>
              row.userId === where?.userId &&
              clauses.some(
                (clause) =>
                  row.titleId === clause.titleId &&
                  row.episodeId === clause.episodeId &&
                  row.kind === clause.kind &&
                  row.occurredAt.getTime() === clause.occurredAt?.getTime() &&
                  row.source === clause.source &&
                  row.note === clause.note,
              ),
          );
        }
        const ids = (where?.id as { in?: string[] } | undefined)?.in;
        if (ids) return this.watchEvents.filter((row) => ids.includes(row.id));
        return this.watchEvents;
      },
      createMany: async ({ data }: { data: Array<Omit<WatchEventState, "id"> & { id?: string }> }) => {
        this.watchEventCreateManyCalls += 1;
        for (const event of data) {
          this.watchEvents.push({
            ...event,
            id: event.id ?? `generated-event-${this.watchEvents.length + 1}`,
          });
        }
        return { count: data.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<WatchEventState> }) => {
        const event = this.watchEvents.find((candidate) => candidate.id === where.id);
        if (!event) throw new Error("missing fake watch event");
        Object.assign(event, data);
        return event;
      },
    },
    suppression: {
      findMany: async () => this.suppressions,
      findUnique: async ({ where }: { where: { userId_matchKey: { matchKey: string } } }) =>
        this.suppressions.find(
          (row) => row.matchKey === where.userId_matchKey.matchKey,
        ) ?? null,
      create: async ({ data }: { data: Omit<SuppressionState, "id"> }) => {
        const created = { ...data, id: `suppression-${this.suppressions.length + 1}` };
        this.suppressions.push(created);
        return created;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<SuppressionState>;
      }) => {
        const row = this.suppressions.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error("missing fake suppression");
        Object.assign(row, data);
        return row;
      },
    },
    titleTag: {
      deleteMany: async () => ({ count: 0 }),
      createMany: async () => ({ count: 0 }),
    },
    season: {
      findMany: async () => [],
      create: async () => ({ id: "season-1" }),
      update: async () => ({ id: "season-1" }),
    },
    episode: {
      findMany: async () => [],
      createMany: async () => ({ count: 0 }),
      update: async () => ({ id: "episode-1" }),
      count: async () => 0,
    },
  };

  readonly prisma = {
    $transaction: async <T>(
      operation: (tx: typeof this.tx) => Promise<T>,
      options?: Record<string, unknown>,
    ): Promise<T> => {
      this.transactionOptions.push(options);
      return operation(this.tx);
    },
    user: this.tx.user,
    title: {
      findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) =>
        where?.id?.in
          ? this.restoreTitle
            ? [{ id: this.restoreTitle.id, seasons: [] }]
            : []
          : this.exportTitles,
    },
    tag: this.tx.tag,
    suppression: this.tx.suppression,
    watchEvent: this.tx.watchEvent,
  };
}

function movieFixture(sourceId = "local-movie"): BackupTitle {
  return {
    sourceId,
    tmdbId: 101,
    mediaType: "MOVIE",
    name: "Event Fixture",
    originalName: null,
    overview: null,
    releaseDate: null,
    posterPath: null,
    backdropPath: null,
    language: "en",
    tmdbRating: null,
    runtime: 100,
    genres: [],
    status: "WATCHED",
    rating: null,
    notes: null,
    watchedAt: stamp,
    favorite: false,
    totalSeasons: null,
    totalEpisodes: null,
    watchedEpisodes: 0,
    source: "tmdb",
    deletedAt: null,
    createdAt: stamp,
    updatedAt: stamp,
    seasons: [],
    tags: [],
  };
}

function storedTitle(title: BackupTitle, userId = "user-1") {
  return {
    ...title,
    id: title.sourceId,
    userId,
    releaseDate: title.releaseDate ? new Date(title.releaseDate) : null,
    watchedAt: title.watchedAt ? new Date(title.watchedAt) : null,
    deletedAt: title.deletedAt ? new Date(title.deletedAt) : null,
    createdAt: new Date(title.createdAt),
    updatedAt: new Date(title.updatedAt),
    seasons: [],
    tags: [],
  };
}

let activeDb = new FakeBackupDb();
const prismaProxy = new Proxy(
  {},
  {
    get: (_target, property) =>
      Reflect.get(activeDb.prisma as unknown as object, property),
  },
);
Object.assign(globalThis, { __CELLULOID_BACKUP_PRISMA__: prismaProxy });

process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET = "backup-runtime-test-secret-not-a-real-value";
process.env.TMDB_ACCESS_TOKEN = "test-tmdb-token";

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
        "export const prisma = globalThis.__CELLULOID_BACKUP_PRISMA__;",
      ),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { analyzeBackupRestore, createBackupEnvelope, restoreBackup } = await import(
  "../src/lib/backup"
);

beforeEach(() => {
  activeDb = new FakeBackupDb();
});

describe("backup database paths", { concurrency: false }, () => {
  it("exports preferences and suppressions from one REPEATABLE READ snapshot", async () => {
    activeDb.user = {
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8, 337],
      recommendModel: "claude-opus-5",
    };
    activeDb.suppressions = [
      {
        id: "suppression-1",
        userId: "user-1",
        matchKey: "tmdb:TV:909",
        tmdbId: 909,
        mediaType: "TV",
        name: "A Refused Series",
        year: 2025,
        reason: "NOT_INTERESTED",
        createdAt: new Date(stamp),
      },
    ];

    const backup = await createBackupEnvelope("user-1");

    assert.deepEqual(backup.user.myProviders, [8, 337]);
    assert.equal(backup.user.recommendModel, "claude-opus-5");
    assert.equal(backup.suppressions?.[0].matchKey, "tmdb:TV:909");
    assert.deepEqual(activeDb.transactionOptions, [
      { isolationLevel: "RepeatableRead", maxWait: 10_000, timeout: 45_000 },
    ]);
  });

  it("omits re-fetchable season and episode metadata from new exports", async () => {
    activeDb.exportTitles = [
      {
        id: "local-tv",
        userId: "user-1",
        tmdbId: 202,
        mediaType: "TV",
        name: "Lean Export",
        originalName: null,
        overview: "Title-level overview stays portable.",
        releaseDate: null,
        posterPath: null,
        backdropPath: null,
        language: "en",
        tmdbRating: null,
        runtime: null,
        genres: [],
        status: "WATCHING",
        rating: null,
        notes: null,
        watchedAt: null,
        favorite: false,
        totalSeasons: 1,
        totalEpisodes: 1,
        watchedEpisodes: 0,
        source: "tmdb",
        deletedAt: null,
        createdAt: new Date(stamp),
        updatedAt: new Date(stamp),
        tags: [],
        seasons: [
          {
            id: "local-season",
            tmdbId: 303,
            seasonNumber: 1,
            name: "Season 1",
            overview: "Derived season prose",
            airDate: new Date(stamp),
            posterPath: "/season.jpg",
            episodeCount: 1,
            episodes: [
              {
                id: "local-episode",
                tmdbId: 404,
                episodeNumber: 1,
                name: "Pilot",
                overview: "Derived episode prose",
                airDate: new Date(stamp),
                runtime: 48,
                stillPath: "/still.jpg",
                watched: false,
                watchedAt: null,
              },
            ],
          },
        ],
      },
    ];

    const backup = await createBackupEnvelope("user-1");
    const title = backup.titles[0];
    const season = title.seasons[0];
    const episode = season.episodes[0];

    assert.equal(title.overview, "Title-level overview stays portable.");
    assert.equal("overview" in season, false);
    assert.equal("overview" in episode, false);
    assert.equal("stillPath" in episode, false);
  });

  it("exports empty curated shares after their last member is purged", async () => {
    activeDb.shares = [
      {
        id: "empty-selection",
        slug: "empty",
        userId: "user-1",
        name: "Purged selection",
        titleIds: ["purged-title"],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: new Date(stamp),
        createdAt: new Date(stamp),
        items: [],
      },
      {
        id: "expired-whole-library",
        slug: "expired",
        userId: "user-1",
        name: "Expired library",
        titleIds: [],
        includeNotes: false,
        includeWatchlist: true,
        scope: "WHOLE_LIBRARY",
        expiresAt: new Date(stamp),
        revokedAt: null,
        createdAt: new Date(stamp),
        items: [],
      },
    ];

    const backup = await createBackupEnvelope("user-1");

    assert.equal(backup.shares.length, 2);
    assert.deepEqual(backup.shares[0], {
      sourceId: "empty-selection",
      name: "Purged selection",
      titleIds: [],
      includeNotes: false,
      includeWatchlist: false,
      scope: "SELECTION",
      expiresAt: null,
      revokedAt: stamp,
      items: [],
      createdAt: stamp,
    });
    assert.equal(backup.shares[1].scope, "WHOLE_LIBRARY");
    assert.equal(backup.shares[1].expiresAt, stamp);
  });

  it("previews and restores suppression dedup plus user preferences", async () => {
    activeDb.suppressions = [
      {
        id: "existing-suppression",
        userId: "user-1",
        matchKey: "tmdb:TV:909",
        tmdbId: 909,
        mediaType: "TV",
        name: "Old Name",
        year: 2024,
        reason: "SEEN_ELSEWHERE",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const backup = emptyEnvelope({
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8, 337],
      recommendModel: "claude-opus-5",
    });
    backup.suppressions = [
      {
        sourceId: "source-existing",
        matchKey: "tmdb:TV:909",
        tmdbId: 909,
        mediaType: "TV",
        name: "Restored Name",
        year: 2025,
        reason: "NOT_INTERESTED",
        createdAt: stamp,
      },
      {
        sourceId: "source-new",
        matchKey: "name:MOVIE:new film|2026",
        tmdbId: null,
        mediaType: "MOVIE",
        name: "New Film",
        year: 2026,
        reason: "SEEN_ELSEWHERE",
        createdAt: stamp,
      },
    ];

    const plan = await analyzeBackupRestore("user-1", backup, "replace-personal");
    assert.deepEqual(plan.counts, previewCounts({
      suppressionsCreate: 1,
      suppressionsUpdate: 1,
      providerSelections: 2,
      providerPreferenceIncluded: 1,
      providerPreferenceUpdate: 1,
      recommendModelPreferenceIncluded: 1,
      recommendModelPreferenceUpdate: 1,
    }));

    const result = await restoreBackup("user-1", backup, "replace-personal", plan);

    assert.deepEqual(activeDb.user, {
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8, 337],
      recommendModel: "claude-opus-5",
    });
    assert.equal(activeDb.suppressions.length, 2);
    assert.equal(activeDb.suppressions[0].name, "Restored Name");
    assert.equal(result.suppressionsCreate, 1);
    assert.equal(result.suppressionsUpdate, 1);
  });

  it("does not clear preferences that an older v2 backup never represented", async () => {
    activeDb.user = {
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8],
      recommendModel: "claude-opus-5",
    };
    const legacyV2 = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });

    const plan = await analyzeBackupRestore("user-1", legacyV2, "replace-personal");
    await restoreBackup("user-1", legacyV2, "replace-personal", plan);

    assert.deepEqual(activeDb.user.myProviders, [8]);
    assert.equal(activeDb.user.recommendModel, "claude-opus-5");
    assert.equal(plan.counts.providerPreferenceIncluded, 0);
    assert.equal(plan.counts.providerPreferenceUpdate, 0);
    assert.equal(plan.counts.recommendModelPreferenceIncluded, 0);
    assert.equal(plan.counts.recommendModelPreferenceUpdate, 0);
  });

  it("leaves every user preference untouched in merge mode", async () => {
    activeDb.user = {
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8],
      recommendModel: null,
    };
    const backup = emptyEnvelope({
      timeZone: "America/New_York",
      watchRegion: "US",
      myProviders: [337],
      recommendModel: "claude-opus-5",
    });

    const plan = await analyzeBackupRestore("user-1", backup, "merge");
    await restoreBackup("user-1", backup, "merge", plan);

    assert.deepEqual(activeDb.user, {
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8],
      recommendModel: null,
    });
    assert.equal(plan.counts.providerPreferenceUpdate, 0);
    assert.equal(plan.counts.recommendModelPreferenceUpdate, 0);
  });

  it("previews wholesale event and suppression creates", async () => {
    const incoming = movieFixture();
    const row = storedTitle(incoming);
    activeDb.exportTitles = [row];
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    backup.watchEvents = [
      {
        sourceId: "event-new",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "REWATCH",
        occurredAt: stamp,
        source: "RESTORE",
        note: null,
        createdAt: stamp,
      },
    ];
    backup.suppressions = [
      {
        sourceId: "suppression-new",
        matchKey: "tmdb:MOVIE:909",
        tmdbId: 909,
        mediaType: "MOVIE",
        name: "Not for me",
        year: 2026,
        reason: "NOT_INTERESTED",
        createdAt: stamp,
      },
    ];

    const plan = await analyzeBackupRestore("user-1", backup, "merge");

    assert.equal(plan.counts.eventsCreate, 1);
    assert.equal(plan.counts.suppressionsCreate, 1);
  });

  it("keeps counter-only TV progress during a backup restore update", async () => {
    const incoming: BackupTitle = {
      sourceId: "source-tv",
      tmdbId: 202,
      mediaType: "TV",
      name: "Counter Only",
      originalName: null,
      overview: null,
      releaseDate: null,
      posterPath: null,
      backdropPath: null,
      language: "en",
      tmdbRating: null,
      runtime: null,
      genres: [],
      status: "WATCHED",
      rating: null,
      notes: null,
      watchedAt: stamp,
      favorite: false,
      totalSeasons: 3,
      totalEpisodes: 62,
      watchedEpisodes: 30,
      source: "import",
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      seasons: [],
      tags: [],
    };
    activeDb.restoreTitle = {
      ...incoming,
      id: "local-tv",
      userId: "user-1",
      sourceId: undefined,
      releaseDate: null,
      watchedAt: new Date(stamp),
      createdAt: new Date(stamp),
      updatedAt: new Date(stamp),
      seasons: [],
      tags: [],
    };
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    const plan: BackupRestorePlan = {
      stateDigest: "counter-only-state",
      counts: previewCounts({ update: 1 }),
      items: [
        {
          action: "update",
          incoming,
          existingId: "local-tv",
          merged: incoming,
        },
      ],
    };

    await restoreBackup("user-1", backup, "replace-personal", plan);

    assert.equal(
      activeDb.titleUpdates.some((data) => data.watchedEpisodes === 0),
      false,
    );
    assert.equal(activeDb.restoreTitle.watchedEpisodes, 30);
  });

  it("changes the state digest even when preference preview counts stay the same", async () => {
    const backup = emptyEnvelope({
      timeZone: "Europe/London",
      watchRegion: "GB",
      myProviders: [8],
      recommendModel: "claude-opus-5",
    });
    activeDb.user.myProviders = [9];
    activeDb.user.recommendModel = "claude-sonnet-5";
    const first = await analyzeBackupRestore("user-1", backup, "replace-personal");

    activeDb.user.myProviders = [337];
    activeDb.user.recommendModel = "claude-haiku-4-5";
    const second = await analyzeBackupRestore("user-1", backup, "replace-personal");

    assert.deepEqual(first.counts, second.counts);
    assert.notEqual(first.stateDigest, second.stateDigest);
  });

  it("restores watch events with two reads and one createMany per chunk", async () => {
    const incoming: BackupTitle = {
      sourceId: "source-title",
      tmdbId: 101,
      mediaType: "MOVIE",
      name: "Event Fixture",
      originalName: null,
      overview: null,
      releaseDate: null,
      posterPath: null,
      backdropPath: null,
      language: "en",
      tmdbRating: null,
      runtime: 100,
      genres: [],
      status: "WATCHED",
      rating: null,
      notes: null,
      watchedAt: stamp,
      favorite: false,
      totalSeasons: null,
      totalEpisodes: null,
      watchedEpisodes: 0,
      source: "tmdb",
      deletedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      seasons: [],
      tags: [],
    };
    activeDb.restoreTitle = { id: "local-title", seasons: [] };
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    backup.watchEvents = Array.from({ length: 75 }, (_, index) => ({
      sourceId: `source-event-${index}`,
      titleId: incoming.sourceId,
      episodeId: null,
      kind: "REWATCH" as const,
      occurredAt: new Date(Date.parse(stamp) + index * 1_000).toISOString(),
      source: "RESTORE" as const,
      note: null,
      createdAt: stamp,
    }));
    const plan: BackupRestorePlan = {
      stateDigest: "event-batch-state",
      counts: previewCounts({ skip: 1 }),
      items: [{ action: "skip", incoming, existingId: "local-title" }],
    };

    const result = await restoreBackup("user-1", backup, "merge", plan);

    assert.equal(result.eventsCreated, 75);
    assert.equal(result.eventsSkipped, 0);
    assert.equal(activeDb.watchEventFindManyCalls, 4);
    assert.equal(activeDb.watchEventCreateManyCalls, 2);
  });

  it("uses source identity before tuple/scalar dedup in merge mode", async () => {
    const incoming = movieFixture();
    const row = storedTitle(incoming);
    activeDb.exportTitles = [row];
    activeDb.restoreTitle = row;
    activeDb.watchEvents = [
      {
        id: "event-1",
        userId: "user-1",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "TITLE_COMPLETED",
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
        source: "MANUAL",
        note: "edited locally",
        createdAt: new Date(stamp),
      },
    ];
    activeDb.shares = [
      {
        id: "share-1",
        slug: "kept-private-link",
        userId: "user-1",
        name: "Renamed locally",
        titleIds: [],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(stamp),
        items: [{ titleId: incoming.sourceId, position: 1 }],
      },
    ];
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    backup.watchEvents = [
      {
        sourceId: "event-1",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "TITLE_COMPLETED",
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "MANUAL",
        note: null,
        createdAt: stamp,
      },
    ];
    backup.shares = [
      {
        sourceId: "share-1",
        name: "Old backup name",
        titleIds: [incoming.sourceId],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: null,
        items: [{ titleId: incoming.sourceId, position: 1 }],
        createdAt: stamp,
      },
    ];

    const plan = await analyzeBackupRestore("user-1", backup, "merge");
    const result = await restoreBackup("user-1", backup, "merge", plan);

    assert.equal(plan.counts.eventsCreate, 0);
    assert.equal(result.eventsCreated, 0);
    assert.equal(result.eventsSkipped, 1);
    assert.equal(result.sharesCreated, 0);
    assert.equal(result.sharesSkipped, 1);
    assert.equal(activeDb.watchEvents.length, 1);
    assert.equal(activeDb.watchEvents[0].note, "edited locally");
    assert.equal(activeDb.shares.length, 1);
    assert.equal(activeDb.shares[0].name, "Renamed locally");
  });

  it("updates source-identical events and shares in replace-personal mode", async () => {
    const incoming = movieFixture();
    const row = storedTitle(incoming);
    activeDb.exportTitles = [row];
    activeDb.restoreTitle = row;
    activeDb.watchEvents = [
      {
        id: "event-1",
        userId: "user-1",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "TITLE_COMPLETED",
        occurredAt: new Date("2026-09-03T00:00:00.000Z"),
        source: "MANUAL",
        note: "edited locally",
        createdAt: new Date(stamp),
      },
    ];
    activeDb.shares = [
      {
        id: "share-1",
        slug: "kept-private-link",
        userId: "user-1",
        name: "Renamed locally",
        titleIds: [incoming.sourceId],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(stamp),
        items: [{ titleId: incoming.sourceId, position: 1 }],
      },
    ];
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    backup.watchEvents = [
      {
        sourceId: "event-1",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "TITLE_COMPLETED",
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "MANUAL",
        note: null,
        createdAt: stamp,
      },
    ];
    backup.shares = [
      {
        sourceId: "share-1",
        name: "Old backup name",
        titleIds: [incoming.sourceId],
        includeNotes: true,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: stamp,
        revokedAt: stamp,
        items: [{ titleId: incoming.sourceId, position: 1 }],
        createdAt: stamp,
      },
    ];

    const plan = await analyzeBackupRestore("user-1", backup, "replace-personal");
    const result = await restoreBackup(
      "user-1",
      backup,
      "replace-personal",
      plan,
    );

    assert.equal(result.eventsCreated, 0);
    assert.equal(activeDb.watchEvents[0].occurredAt.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(activeDb.watchEvents[0].note, null);
    assert.equal(result.sharesCreated, 0);
    assert.equal(activeDb.shares[0].slug, "kept-private-link");
    assert.equal(activeDb.shares[0].name, "Old backup name");
    assert.deepEqual(activeDb.shares[0].titleIds, []);
    assert.deepEqual(activeDb.shares[0].items, [
      { titleId: incoming.sourceId, position: 1 },
    ]);
    assert.equal(activeDb.shares[0].revokedAt?.toISOString(), stamp);
  });

  it("does not adopt source ids occupied by another account", async () => {
    const incoming = movieFixture();
    const row = storedTitle(incoming);
    activeDb.exportTitles = [row];
    activeDb.restoreTitle = row;
    activeDb.watchEvents = [
      {
        id: "occupied-event",
        userId: "friend-2",
        titleId: "friend-title",
        episodeId: null,
        kind: "REWATCH",
        occurredAt: new Date(stamp),
        source: "MANUAL",
        note: null,
        createdAt: new Date(stamp),
      },
    ];
    activeDb.shares = [
      {
        id: "occupied-share",
        slug: "friends-link",
        userId: "friend-2",
        name: "Friend's share",
        titleIds: [],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: null,
        createdAt: new Date(stamp),
        items: [],
      },
    ];
    const backup = emptyEnvelope({ timeZone: "UTC", watchRegion: "US" });
    backup.titles = [incoming];
    backup.watchEvents = [
      {
        sourceId: "occupied-event",
        titleId: incoming.sourceId,
        episodeId: null,
        kind: "REWATCH",
        occurredAt: stamp,
        source: "MANUAL",
        note: null,
        createdAt: stamp,
      },
    ];
    backup.shares = [
      {
        sourceId: "occupied-share",
        name: "My restored share",
        titleIds: [incoming.sourceId],
        includeNotes: false,
        includeWatchlist: false,
        scope: "SELECTION",
        expiresAt: null,
        revokedAt: null,
        items: [{ titleId: incoming.sourceId, position: 1 }],
        createdAt: stamp,
      },
    ];

    const plan = await analyzeBackupRestore("user-1", backup, "merge");
    const result = await restoreBackup("user-1", backup, "merge", plan);

    assert.equal(result.eventsCreated, 1);
    assert.equal(result.sharesCreated, 1);
    assert.equal(activeDb.watchEvents[0].userId, "friend-2");
    assert.notEqual(activeDb.watchEvents[1].id, "occupied-event");
    assert.equal(activeDb.shares[0].userId, "friend-2");
    assert.notEqual(activeDb.shares[1].id, "occupied-share");
  });
});
