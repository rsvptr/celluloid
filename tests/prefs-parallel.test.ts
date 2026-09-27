import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

// VE-13: queries that don't need the owner's time zone must not wait for the
// prefs read. The fakes are lazy like PrismaPromise, which only runs a query
// once something calls `then`: creating a query before `await getUserPrefs`
// would not start it, so each query logs when it actually starts.

const started: string[] = [];
let releasePrefs: () => void = () => {};

function lazy<T>(label: string, value: T) {
  return {
    then<R1, R2>(onFulfilled?: (v: T) => R1, onRejected?: (e: unknown) => R2) {
      started.push(label);
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
  };
}

function sqlLabel(strings: TemplateStringsArray) {
  const sql = strings.join("?");
  if (sql.includes("to_char")) return "activity";
  if (sql.includes("'REWATCH'")) return "mostRewatched";
  return "waiting";
}

Object.assign(globalThis, {
  __CELLULOID_PREFS_PARALLEL_PRISMA__: {
    user: {
      findUnique: () => ({
        then<R1, R2>(onFulfilled?: (v: unknown) => R1, onRejected?: (e: unknown) => R2) {
          started.push("prefs");
          return new Promise<void>((resolve) => {
            releasePrefs = resolve;
          })
            .then(() => ({ timeZone: "Asia/Kolkata", watchRegion: null, myProviders: [], lastBackupAt: null }))
            .then(onFulfilled, onRejected);
        },
      }),
    },
    title: {
      findMany: () => lazy("title.findMany", []),
      aggregate: () => lazy("title.aggregate", { _count: { _all: 0 }, _max: { metadataSyncedAt: null } }),
    },
    episode: {
      aggregate: () =>
        lazy("episode.aggregate", { _sum: { runtime: null }, _count: { _all: 0, runtime: 0 } }),
    },
    watchEvent: { count: () => lazy("watchEvent.count", 0) },
    $queryRaw: (strings: TemplateStringsArray) => lazy(sqlLabel(strings), []),
  },
});

const loader = `
const prismaStub = "export const prisma = globalThis.__CELLULOID_PREFS_PARALLEL_PRISMA__;";
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return { url: "data:text/javascript," + encodeURIComponent(prismaStub), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { getStats } = await import("../src/lib/data");
const { getUpcoming } = await import("../src/app/(app)/upcoming/data");

/** Lets every pending microtask and I/O callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("time-zone-free queries don't wait for prefs (VE-13)", { concurrency: false }, () => {
  beforeEach(() => {
    started.length = 0;
  });

  it("getStats starts all but the day-bucketing query during the prefs read", async () => {
    const stats = getStats("user-stats");
    await settle();
    assert.deepEqual([...started].sort(), [
      "episode.aggregate",
      "mostRewatched",
      "prefs",
      "title.findMany",
      "watchEvent.count",
    ]);

    releasePrefs();
    await stats;
    assert.equal(started.at(-1), "activity");
  });

  it("getUpcoming starts the tracked-show aggregate during the prefs read", async () => {
    const upcoming = getUpcoming("user-upcoming");
    await settle();
    assert.deepEqual([...started].sort(), ["prefs", "title.aggregate"]);

    releasePrefs();
    await upcoming;
    assert.deepEqual([...started].sort(), ["prefs", "title.aggregate", "title.findMany", "waiting"]);
  });
});
