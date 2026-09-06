import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import {
  MediaType,
  WatchEventKind,
  WatchEventSource,
  WatchStatus,
} from "../src/generated/prisma/client";

type EventRow = {
  id?: string;
  userId: string;
  titleId: string;
  episodeId?: string | null;
  kind: WatchEventKind;
  source: WatchEventSource;
  note?: string | null;
  occurredAt: Date;
};

type UpdateData = {
  status?: WatchStatus;
  watchedAt?: Date | null;
  watchedEpisodes?: number;
};

class FakeWatchDb {
  status: WatchStatus = WatchStatus.WATCHING;
  watchedAt: Date | null = null;
  watchedEpisodes = 0;
  totalEpisodes: number | null = 1;
  mediaType: MediaType = MediaType.TV;
  episodeRows = 1;
  episodeWatched = false;
  episodeWatchedAt: Date | null = null;
  events: EventRow[] = [];
  deleteManyCalls = 0;
  lockQueries = 0;
  failNextTitleUpdate = false;

  private transactionTail: Promise<unknown> = Promise.resolve();

  private applyTitleUpdate(data: UpdateData) {
    if (data.status !== undefined) this.status = data.status;
    if (data.watchedAt !== undefined) this.watchedAt = data.watchedAt;
    if (data.watchedEpisodes !== undefined) this.watchedEpisodes = data.watchedEpisodes;
  }

  private readonly tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      this.lockQueries += 1;
      const sql = strings.join("?");
      if (sql.includes('SELECT "userId", status, "watchedAt"')) {
        return [
          { userId: "user-1", status: this.status, watchedAt: this.watchedAt },
        ];
      }
      if (sql.includes('SELECT status, "watchedAt", "totalEpisodes"')) {
        return [
          {
            status: this.status,
            watchedAt: this.watchedAt,
            totalEpisodes: this.totalEpisodes,
            watchedEpisodes: this.watchedEpisodes,
            mediaType: this.mediaType,
          },
        ];
      }
      if (sql.includes('SELECT id, "userId", status')) {
        return [
          {
            id: "title-1",
            userId: "user-1",
            status: this.status,
            watchedAt: this.watchedAt,
            watchedEpisodes: this.watchedEpisodes,
            mediaType: this.mediaType,
          },
        ];
      }
      if (sql.includes('SELECT status, "watchedAt"')) {
        return [{ status: this.status, watchedAt: this.watchedAt }];
      }
      if (sql.includes('SELECT status, "mediaType"')) {
        return [
          { status: this.status, mediaType: this.mediaType, watchedAt: this.watchedAt },
        ];
      }
      if (sql.includes('SELECT id, "watchedAt"')) {
        return [{ id: "title-1", watchedAt: this.watchedAt }];
      }
      return [{ id: "title-1" }];
    },
    title: {
      update: async ({ data }: { data: UpdateData }) => {
        if (this.failNextTitleUpdate) {
          this.failNextTitleUpdate = false;
          throw new Error("simulated title update failure");
        }
        this.applyTitleUpdate(data);
        return { id: "title-1" };
      },
    },
    episode: {
      findFirst: async () => ({ watched: this.episodeWatched }),
      findMany: async () =>
        this.episodeRows > 0 && !this.episodeWatched ? [{ id: "episode-1" }] : [],
      update: async ({ data }: { data: { watched: boolean; watchedAt: Date | null } }) => {
        this.episodeWatched = data.watched;
        this.episodeWatchedAt = data.watchedAt;
        return { id: "episode-1" };
      },
      updateMany: async ({ data }: { data: { watched: boolean; watchedAt: Date | null } }) => {
        const changed =
          this.episodeRows > 0 && this.episodeWatched !== data.watched ? 1 : 0;
        if (this.episodeRows > 0) {
          this.episodeWatched = data.watched;
          this.episodeWatchedAt = data.watchedAt;
        }
        return { count: changed };
      },
      count: async ({ where }: { where: { watched?: boolean } }) =>
        where.watched === true
          ? this.episodeRows * Number(this.episodeWatched)
          : this.episodeRows,
    },
    watchEvent: {
      create: async ({ data }: { data: EventRow }) => {
        const event = { ...data, id: data.id ?? `event-${this.events.length + 1}` };
        this.events.push(event);
        return event;
      },
      createMany: async ({ data }: { data: EventRow[] }) => {
        this.events.push(
          ...data.map((event, index) => ({
            ...event,
            id: event.id ?? `event-${this.events.length + index + 1}`,
          })),
        );
        return { count: data.length };
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = this.events.findIndex((event) => event.id === where.id);
        if (index < 0) throw new Error("missing fake watch event");
        return this.events.splice(index, 1)[0];
      },
      deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        this.deleteManyCalls += 1;
        const before = this.events.length;
        if (where?.occurredAt instanceof Date) {
          const occurredAt = where.occurredAt;
          this.events = this.events.filter(
            (event) =>
              !(
                event.userId === where.userId &&
                event.titleId === where.titleId &&
                event.source === where.source &&
                event.occurredAt.getTime() === occurredAt.getTime() &&
                (event.kind === WatchEventKind.EPISODE_WATCHED ||
                  event.kind === WatchEventKind.TITLE_COMPLETED)
              ),
          );
        } else {
          this.events = this.events.filter(
            (event) =>
              !(
                event.episodeId === "episode-1" &&
                event.kind === WatchEventKind.EPISODE_WATCHED &&
                (event.source === WatchEventSource.MANUAL ||
                  event.source === WatchEventSource.BULK) &&
                event.note == null
              ),
          );
        }
        return { count: before - this.events.length };
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        const occurredAt = where.occurredAt;
        return this.events
          .filter(
            (event) =>
              event.userId === where.userId &&
              event.titleId === where.titleId &&
              event.source === where.source &&
              occurredAt instanceof Date &&
              event.occurredAt.getTime() === occurredAt.getTime() &&
              (event.kind === WatchEventKind.EPISODE_WATCHED ||
                event.kind === WatchEventKind.TITLE_COMPLETED),
          )
          .map((event) => ({ kind: event.kind, episodeId: event.episodeId ?? null }));
      },
      findFirst: async () =>
        [...this.events]
          .filter(
            (event) =>
              event.kind === WatchEventKind.TITLE_COMPLETED ||
              event.kind === WatchEventKind.REWATCH,
          )
          .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime())[0] ??
        null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: { occurredAt?: Date; note?: string | null };
      }) => {
        const event = this.events.find((candidate) => candidate.id === where.id);
        if (event) {
          if (data.occurredAt !== undefined) event.occurredAt = data.occurredAt;
          if (data.note !== undefined) event.note = data.note;
        }
        return event ?? { id: where.id };
      },
      count: async () =>
        this.events.filter(
          (event) =>
            event.kind === WatchEventKind.TITLE_COMPLETED ||
            event.kind === WatchEventKind.REWATCH,
        ).length,
    },
  };

  readonly prisma = {
    $transaction: <T>(operation: (tx: typeof this.tx) => Promise<T>): Promise<T> => {
      const run = this.transactionTail.then(async () => {
        const snapshot = {
          status: this.status,
          watchedAt: this.watchedAt ? new Date(this.watchedAt) : null,
          watchedEpisodes: this.watchedEpisodes,
          episodeWatched: this.episodeWatched,
          episodeWatchedAt: this.episodeWatchedAt
            ? new Date(this.episodeWatchedAt)
            : null,
          events: this.events.map((event) => ({
            ...event,
            occurredAt: new Date(event.occurredAt),
          })),
          deleteManyCalls: this.deleteManyCalls,
        };
        try {
          return await operation(this.tx);
        } catch (error) {
          this.status = snapshot.status;
          this.watchedAt = snapshot.watchedAt;
          this.watchedEpisodes = snapshot.watchedEpisodes;
          this.episodeWatched = snapshot.episodeWatched;
          this.episodeWatchedAt = snapshot.episodeWatchedAt;
          this.events = snapshot.events;
          this.deleteManyCalls = snapshot.deleteManyCalls;
          throw error;
        }
      });
      this.transactionTail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    title: {
      findFirst: async () => ({ id: "title-1" }),
      findMany: async () => [{ id: "title-1" }],
    },
    season: {
      findFirst: async () => ({ titleId: "title-1" }),
    },
    episode: {
      findFirst: async () => ({
        id: "episode-1",
        season: { titleId: "title-1" },
      }),
    },
    watchEvent: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
        const event = this.events.find(
          (candidate) => candidate.id === where.id && candidate.userId === where.userId,
        );
        return event
          ? { id: event.id, titleId: event.titleId, occurredAt: event.occurredAt }
          : null;
      },
    },
  };
}

let activeDb = new FakeWatchDb();
const prismaProxy = new Proxy(
  {},
  {
    get: (_target, property) =>
      Reflect.get(activeDb.prisma as unknown as object, property),
  },
);
Object.assign(globalThis, {
  __CELLULOID_ACTIONS_PRISMA__: prismaProxy,
  __CELLULOID_ACTIONS_SIGNED_IN__: true,
});

const mockModules = new Map<string, string>([
  ["@/lib/prisma", "export const prisma = globalThis.__CELLULOID_ACTIONS_PRISMA__;"],
  [
    "@/lib/session",
    'export async function getSession() { return globalThis.__CELLULOID_ACTIONS_SIGNED_IN__ ? { user: { id: "user-1" } } : null; }',
  ],
  ["next/cache", "export function revalidatePath() {}"],
  [
    "@/lib/tmdb",
    "export async function getMovie() { throw new Error('unused'); }\n" +
      "export async function getSeason() { throw new Error('unused'); }\n" +
      "export async function getTv() { throw new Error('unused'); }",
  ],
]);
const loader = `
const modules = new Map(${JSON.stringify([...mockModules])});
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const source =
    modules.get(specifier) ??
    (normalized.endsWith("/src/lib/prisma")
      ? modules.get("@/lib/prisma")
      : normalized.endsWith("/src/lib/session")
        ? modules.get("@/lib/session")
        : normalized.endsWith("/src/lib/tmdb")
          ? modules.get("@/lib/tmdb")
          : undefined);
  if (source !== undefined) {
    return {
      url: "data:text/javascript," + encodeURIComponent(source),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const {
  bulkSetStatus,
  deleteWatchEvent,
  logWatch,
  setAllEpisodesWatched,
  setEpisodeWatched,
  setSeasonWatched,
  undoWatchedTransition,
  updateTitle,
  updateWatchEvent,
} = await import("../src/lib/actions");

describe("watch transition locking", { concurrency: false }, () => {
  it("returns safe action errors instead of throwing them", async () => {
    activeDb = new FakeWatchDb();
    const invalid = { error: "Invalid request. Refresh and try again." };

    Object.assign(globalThis, { __CELLULOID_ACTIONS_SIGNED_IN__: false });
    try {
      assert.deepEqual(await updateTitle("title-1", { status: WatchStatus.WATCHED }), {
        error: "You're signed out. Sign in and try again.",
      });
    } finally {
      Object.assign(globalThis, { __CELLULOID_ACTIONS_SIGNED_IN__: true });
    }

    assert.deepEqual(await updateTitle("", { status: WatchStatus.WATCHED }), invalid);
    assert.deepEqual(await setEpisodeWatched("", true), invalid);
    assert.deepEqual(await undoWatchedTransition("", new Date().toISOString()), invalid);
    assert.deepEqual(
      await bulkSetStatus(
        Array.from({ length: 1001 }, (_, index) => `title-${index}`),
        WatchStatus.WATCHED,
      ),
      { error: "Too many titles selected (max 1000)." },
    );
  });

  it("logs one title completion when concurrent requests set WATCHED", async () => {
    activeDb = new FakeWatchDb();
    await Promise.all([
      updateTitle("title-1", { status: WatchStatus.WATCHED }),
      updateTitle("title-1", { status: WatchStatus.WATCHED }),
    ]);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.EPISODE_WATCHED)
        .length,
      1,
    );
  });

  it("emits episode history only on a real transition and clears all generated duplicates", async () => {
    activeDb = new FakeWatchDb();
    await setEpisodeWatched("episode-1", true);
    await setEpisodeWatched("episode-1", true);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.EPISODE_WATCHED)
        .length,
      1,
    );
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );

    activeDb.events.push(
      {
        userId: "user-1",
        titleId: "title-1",
        episodeId: "episode-1",
        kind: WatchEventKind.EPISODE_WATCHED,
        source: WatchEventSource.BULK,
        occurredAt: new Date(),
      },
      {
        userId: "user-1",
        titleId: "title-1",
        episodeId: "episode-1",
        kind: WatchEventKind.EPISODE_WATCHED,
        source: WatchEventSource.MANUAL,
        note: "Keep this history",
        occurredAt: new Date(),
      },
    );

    await setEpisodeWatched("episode-1", false);
    await setEpisodeWatched("episode-1", false);

    assert.equal(activeDb.deleteManyCalls, 1);
    assert.deepEqual(
      activeDb.events
        .filter((event) => event.kind === WatchEventKind.EPISODE_WATCHED)
        .map((event) => event.note),
      ["Keep this history"],
    );
  });

  it("records exactly one completion the first time the tracker finishes a show", async () => {
    activeDb = new FakeWatchDb();

    await setEpisodeWatched("episode-1", true);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.ok(activeDb.watchedAt);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );
  });

  it("does not invent another completion when a final-episode correction re-enters WATCHED", async () => {
    activeDb = new FakeWatchDb();
    await setEpisodeWatched("episode-1", true);
    const firstWatchedAt = activeDb.watchedAt;

    await setEpisodeWatched("episode-1", false);
    await setEpisodeWatched("episode-1", true);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.strictEqual(activeDb.watchedAt, firstWatchedAt);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );
  });

  it("preserves a deliberate WATCHING status when episode progress returns to zero", async () => {
    activeDb = new FakeWatchDb();
    activeDb.status = WatchStatus.WATCHING;
    activeDb.episodeWatched = true;
    activeDb.watchedEpisodes = 1;

    await setEpisodeWatched("episode-1", false);

    assert.equal(activeDb.watchedEpisodes, 0);
    assert.equal(activeDb.status, WatchStatus.WATCHING);
  });

  it("uses the explicit completion date for TV episode stamps and history", async () => {
    activeDb = new FakeWatchDb();
    const completedAt = "2020-01-02T03:04:05.000Z";

    await updateTitle("title-1", {
      status: WatchStatus.WATCHED,
      watchedAt: completedAt,
    });

    assert.equal(activeDb.episodeWatchedAt?.toISOString(), completedAt);
    assert.deepEqual(
      activeDb.events.map((event) => [event.kind, event.occurredAt.toISOString()]),
      [
        [WatchEventKind.EPISODE_WATCHED, completedAt],
        [WatchEventKind.TITLE_COMPLETED, completedAt],
      ],
    );
  });

  it("undoes one TV WATCHED transition and removes every event from its instant", async () => {
    activeDb = new FakeWatchDb();

    const result = await updateTitle("title-1", { status: WatchStatus.WATCHED });
    assert.ok(result.undo);
    const transitionAt = result.undo.occurredAt;
    assert.equal(activeDb.episodeWatched, true);
    assert.equal(activeDb.events.length, 2);
    assert.ok(
      activeDb.events.every(
        (event) =>
          event.source === WatchEventSource.BULK &&
          event.occurredAt.toISOString() === transitionAt,
      ),
    );

    assert.deepEqual(
      await undoWatchedTransition(result.undo.titleId, transitionAt),
      { ok: true },
    );
    assert.equal(activeDb.episodeWatched, false);
    assert.equal(activeDb.status, WatchStatus.WATCHLIST);
    assert.equal(
      activeDb.events.filter((event) => event.occurredAt.toISOString() === transitionAt)
        .length,
      0,
    );
  });

  it("keeps a date entered before the title transitions to WATCHED", async () => {
    activeDb = new FakeWatchDb();
    activeDb.mediaType = MediaType.MOVIE;
    activeDb.totalEpisodes = null;
    activeDb.status = WatchStatus.WATCHLIST;
    activeDb.watchedAt = new Date("2020-05-01T00:00:00.000Z");

    await updateTitle("title-1", { status: WatchStatus.WATCHED });

    assert.equal(activeDb.watchedAt?.toISOString(), "2020-05-01T00:00:00.000Z");
    assert.equal(activeDb.events.length, 1);
    assert.equal(activeDb.events[0]?.kind, WatchEventKind.TITLE_COMPLETED);
    assert.equal(
      activeDb.events[0]?.occurredAt.toISOString(),
      "2020-05-01T00:00:00.000Z",
    );
  });

  it("keeps a pre-existing date for bulk movie and TV completions", async () => {
    for (const mediaType of [MediaType.MOVIE, MediaType.TV]) {
      activeDb = new FakeWatchDb();
      activeDb.mediaType = mediaType;
      activeDb.totalEpisodes = mediaType === MediaType.TV ? 1 : null;
      activeDb.status = WatchStatus.WATCHLIST;
      activeDb.watchedAt = new Date("2020-05-01T00:00:00.000Z");

      await bulkSetStatus(["title-1"], WatchStatus.WATCHED);

      assert.equal(activeDb.watchedAt?.toISOString(), "2020-05-01T00:00:00.000Z");
      assert.ok(activeDb.events.length >= 1);
      assert.ok(
        activeDb.events.every(
          (event) => event.occurredAt.toISOString() === "2020-05-01T00:00:00.000Z",
        ),
      );
    }
  });

  it("resyncs watchedAt when redating the latest completion behind an older one", async () => {
    activeDb = new FakeWatchDb();
    activeDb.status = WatchStatus.WATCHED;
    activeDb.watchedAt = new Date("2025-01-01T00:00:00.000Z");
    activeDb.events = [
      {
        id: "completion-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.TITLE_COMPLETED,
        source: WatchEventSource.MANUAL,
        occurredAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      {
        id: "rewatch-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.REWATCH,
        source: WatchEventSource.MANUAL,
        occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ];

    await updateTitle("title-1", { watchedAt: "2023-01-01T00:00:00.000Z" });

    assert.equal(
      activeDb.events.find((event) => event.id === "rewatch-1")?.occurredAt.toISOString(),
      "2023-01-01T00:00:00.000Z",
    );
    assert.equal(activeDb.watchedAt?.toISOString(), "2024-01-01T00:00:00.000Z");
  });

  it("does not move an imported watchedAt backward on a note-only history edit", async () => {
    activeDb = new FakeWatchDb();
    activeDb.status = WatchStatus.WATCHED;
    activeDb.watchedAt = new Date("2020-06-01T00:00:00.000Z");
    activeDb.events = [
      {
        id: "completion-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.TITLE_COMPLETED,
        source: WatchEventSource.MANUAL,
        occurredAt: new Date("2019-01-01T00:00:00.000Z"),
      },
    ];

    await updateWatchEvent("completion-1", {
      occurredAt: "2019-01-01T00:00:00.000Z",
      note: "with Dad",
    });

    assert.equal(activeDb.watchedAt?.toISOString(), "2020-06-01T00:00:00.000Z");
  });

  it("restores a WATCHED title date from history when the field is cleared", async () => {
    activeDb = new FakeWatchDb();
    activeDb.status = WatchStatus.WATCHED;
    activeDb.watchedAt = new Date("2026-03-03T00:00:00.000Z");
    activeDb.events = [
      {
        id: "completion-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.TITLE_COMPLETED,
        source: WatchEventSource.MANUAL,
        occurredAt: new Date("2026-03-03T00:00:00.000Z"),
      },
    ];

    await updateTitle("title-1", { watchedAt: null });

    assert.equal(activeDb.watchedAt?.toISOString(), "2026-03-03T00:00:00.000Z");
  });

  it("uses TITLE_COMPLETED after the only completion event was removed", async () => {
    activeDb = new FakeWatchDb();
    activeDb.mediaType = MediaType.MOVIE;
    activeDb.totalEpisodes = null;
    activeDb.status = WatchStatus.WATCHED;
    activeDb.watchedAt = new Date("2026-08-20T00:00:00.000Z");
    activeDb.events = [
      {
        id: "completion-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.TITLE_COMPLETED,
        source: WatchEventSource.MANUAL,
        occurredAt: new Date("2026-08-20T00:00:00.000Z"),
      },
    ];

    await deleteWatchEvent("completion-1");
    const result = await logWatch("title-1", {
      occurredAt: "2026-09-01T00:00:00.000Z",
    });

    assert.deepEqual(result, { ok: true, watchCount: 1 });
    assert.equal(activeDb.events.length, 1);
    assert.equal(activeDb.events[0]?.kind, WatchEventKind.TITLE_COMPLETED);
  });

  it("guards a generic partial-TV log instead of inventing a completion", async () => {
    activeDb = new FakeWatchDb();
    activeDb.status = WatchStatus.WATCHING;
    activeDb.totalEpisodes = 10;
    activeDb.watchedEpisodes = 3;
    activeDb.watchedAt = new Date("2024-01-01T00:00:00.000Z");

    const result = await logWatch("title-1", {
      occurredAt: "2026-01-01T00:00:00.000Z",
      note: "Episode from memory",
    });

    assert.deepEqual(result, {
      error:
        "This show is still in progress. Log individual episodes from the episode tracker instead.",
    });
    assert.equal(activeDb.status, WatchStatus.WATCHING);
    assert.equal(activeDb.watchedAt?.toISOString(), "2024-01-01T00:00:00.000Z");
    assert.deepEqual(activeDb.events, []);
  });

  it("preserves an event note when an edit omits the note field", async () => {
    activeDb = new FakeWatchDb();
    activeDb.events = [
      {
        id: "event-1",
        userId: "user-1",
        titleId: "title-1",
        kind: WatchEventKind.TITLE_COMPLETED,
        source: WatchEventSource.MANUAL,
        note: "Keep this note",
        occurredAt: new Date("2025-01-01T00:00:00.000Z"),
      },
    ];

    const result = await updateWatchEvent("event-1", {
      occurredAt: "2025-02-03T00:00:00.000Z",
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(activeDb.events[0]?.note, "Keep this note");
    assert.equal(
      activeDb.events[0]?.occurredAt.toISOString(),
      "2025-02-03T00:00:00.000Z",
    );
  });

  it("creates the same title completion when a season action finishes a show", async () => {
    activeDb = new FakeWatchDb();

    await setSeasonWatched("season-1", true);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.EPISODE_WATCHED)
        .length,
      1,
    );
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );
  });

  it("runs season and show unwatch writes behind the Title lock", async () => {
    activeDb = new FakeWatchDb();
    activeDb.episodeWatched = true;
    await setSeasonWatched("season-1", false);
    assert.equal(activeDb.episodeWatched, false);
    assert.equal(activeDb.lockQueries, 1, "season write and recount share one lock");

    activeDb = new FakeWatchDb();
    activeDb.episodeWatched = true;
    await setAllEpisodesWatched("title-1", false);
    assert.equal(activeDb.episodeWatched, false);
    assert.equal(activeDb.lockQueries, 1, "show write and recount share one lock");
  });

  it("rolls back the episode and history when the progress update fails", async () => {
    activeDb = new FakeWatchDb();
    activeDb.failNextTitleUpdate = true;

    await assert.rejects(
      setEpisodeWatched("episode-1", true),
      /simulated title update failure/,
    );

    assert.equal(activeDb.episodeWatched, false);
    assert.equal(activeDb.episodeWatchedAt, null);
    assert.equal(activeDb.watchedEpisodes, 0);
    assert.equal(activeDb.status, WatchStatus.WATCHING);
    assert.deepEqual(activeDb.events, []);
  });

  it("makes concurrent bulk WATCHED requests one completion transition", async () => {
    activeDb = new FakeWatchDb();
    activeDb.mediaType = MediaType.MOVIE;
    await Promise.all([
      bulkSetStatus(["title-1"], WatchStatus.WATCHED),
      bulkSetStatus(["title-1"], WatchStatus.WATCHED),
    ]);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.equal(
      activeDb.events.filter((event) => event.kind === WatchEventKind.TITLE_COMPLETED)
        .length,
      1,
    );
  });

  it("keeps aggregate TV progress when updateTitle has no Episode rows to recount", async () => {
    activeDb = new FakeWatchDb();
    activeDb.totalEpisodes = 62;
    activeDb.watchedEpisodes = 30;
    activeDb.episodeRows = 0;

    await updateTitle("title-1", { status: WatchStatus.WATCHED });

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.equal(activeDb.watchedEpisodes, 30);
  });

  it("keeps aggregate TV progress when bulk WATCHED has no Episode rows to recount", async () => {
    activeDb = new FakeWatchDb();
    activeDb.totalEpisodes = 62;
    activeDb.watchedEpisodes = 30;
    activeDb.episodeRows = 0;

    await bulkSetStatus(["title-1"], WatchStatus.WATCHED);

    assert.equal(activeDb.status, WatchStatus.WATCHED);
    assert.equal(activeDb.watchedEpisodes, 30);
  });
});
