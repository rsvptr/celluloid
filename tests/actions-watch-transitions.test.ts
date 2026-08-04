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
  userId: string;
  titleId: string;
  episodeId?: string;
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
  events: EventRow[] = [];
  deleteManyCalls = 0;
  lockQueries = 0;

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
      if (sql.includes('SELECT status, "watchedAt", "totalEpisodes"')) {
        return [
          {
            status: this.status,
            watchedAt: this.watchedAt,
            totalEpisodes: this.totalEpisodes,
          },
        ];
      }
      if (sql.includes('SELECT status, "watchedAt"')) {
        return [{ status: this.status, watchedAt: this.watchedAt }];
      }
      if (sql.includes('SELECT status, "mediaType"')) {
        return [{ status: this.status, mediaType: this.mediaType }];
      }
      return [{ id: "title-1" }];
    },
    title: {
      update: async ({ data }: { data: UpdateData }) => {
        this.applyTitleUpdate(data);
        return { id: "title-1" };
      },
    },
    episode: {
      findFirst: async () => ({ watched: this.episodeWatched }),
      update: async ({ data }: { data: { watched: boolean; watchedAt: Date | null } }) => {
        this.episodeWatched = data.watched;
        return { id: "episode-1" };
      },
      updateMany: async ({ data }: { data: { watched: boolean; watchedAt: Date | null } }) => {
        const changed =
          this.episodeRows > 0 && this.episodeWatched !== data.watched ? 1 : 0;
        if (this.episodeRows > 0) this.episodeWatched = data.watched;
        return { count: changed };
      },
      count: async ({ where }: { where: { watched?: boolean } }) =>
        where.watched === true
          ? this.episodeRows * Number(this.episodeWatched)
          : this.episodeRows,
    },
    watchEvent: {
      create: async ({ data }: { data: EventRow }) => {
        this.events.push(data);
        return { id: `event-${this.events.length}` };
      },
      createMany: async ({ data }: { data: EventRow[] }) => {
        this.events.push(...data);
        return { count: data.length };
      },
      deleteMany: async () => {
        this.deleteManyCalls += 1;
        const before = this.events.length;
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
        return { count: before - this.events.length };
      },
      findFirst: async () => null,
      update: async () => ({ id: "event-1" }),
    },
  };

  readonly prisma = {
    $transaction: <T>(operation: (tx: typeof this.tx) => Promise<T>): Promise<T> => {
      const run = this.transactionTail.then(() => operation(this.tx));
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
Object.assign(globalThis, { __CELLULOID_ACTIONS_PRISMA__: prismaProxy });

const mockModules = new Map<string, string>([
  ["@/lib/prisma", "export const prisma = globalThis.__CELLULOID_ACTIONS_PRISMA__;"],
  [
    "@/lib/session",
    'export async function getSession() { return { user: { id: "user-1" } }; }',
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

const { bulkSetStatus, setAllEpisodesWatched, setEpisodeWatched, setSeasonWatched, updateTitle } =
  await import("../src/lib/actions");

describe("watch transition locking", { concurrency: false }, () => {
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
      activeDb.events.map((event) => event.note),
      ["Keep this history"],
    );
  });

  it("runs season and show unwatch writes behind the Title lock", async () => {
    activeDb = new FakeWatchDb();
    activeDb.episodeWatched = true;
    await setSeasonWatched("season-1", false);
    assert.equal(activeDb.episodeWatched, false);
    assert.ok(activeDb.lockQueries >= 2, "season write and progress recompute both lock");

    activeDb = new FakeWatchDb();
    activeDb.episodeWatched = true;
    await setAllEpisodesWatched("title-1", false);
    assert.equal(activeDb.episodeWatched, false);
    assert.ok(activeDb.lockQueries >= 2, "show write and progress recompute both lock");
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
