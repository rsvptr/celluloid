import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { Prisma } from "../src/generated/prisma/client";

// PR-10: the three single-row writes that used to throw on a benign race,
// driven through the real actions with a stubbed Prisma that raises the error
// the race produces (shapes as captured from Prisma 7.10 on Postgres).

function known(code: string, meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("test", { code, clientVersion: "7.10.0", meta });
}
const titleTagDuplicate = () =>
  known("P2002", {
    modelName: "TitleTag",
    driverAdapterError: {
      cause: { kind: "UniqueConstraintViolation", constraint: { index: "TitleTag_pkey" } },
    },
  });
const watchEventMissing = (operation: string) =>
  known("P2025", { modelName: "WatchEvent", operation });

type State = {
  upsertError: unknown;
  deleteError: unknown;
  updateError: unknown;
  titleUpdates: unknown[];
  surviving: number;
  revalidated: string[];
};
const state: State = {
  upsertError: null,
  deleteError: null,
  updateError: null,
  titleUpdates: [],
  surviving: 0,
  revalidated: [],
};

const tx = {
  $queryRaw: async () => [{ id: "title-1", watchedAt: new Date("2026-09-01T20:00:00.000Z") }],
  watchEvent: {
    delete: async () => {
      if (state.deleteError) throw state.deleteError;
      return {};
    },
    update: async () => {
      if (state.updateError) throw state.updateError;
      return {};
    },
    findFirst: async () => null,
    count: async () => state.surviving,
  },
  title: {
    update: async (args: unknown) => {
      state.titleUpdates.push(args);
      return {};
    },
  },
};
const fakePrisma = {
  $transaction: async <T>(operation: (client: typeof tx) => Promise<T>) => operation(tx),
  title: { findFirst: async () => ({ id: "title-1" }) },
  tag: { findFirst: async () => ({ id: "tag-1" }) },
  titleTag: {
    upsert: async () => {
      if (state.upsertError) throw state.upsertError;
      return {};
    },
    deleteMany: async () => ({ count: 0 }),
  },
  watchEvent: {
    findFirst: async () => ({
      id: "event-1",
      titleId: "title-1",
      occurredAt: new Date("2026-09-01T20:00:00.000Z"),
    }),
  },
};
Object.assign(globalThis, {
  __CELLULOID_RACES_PRISMA__: fakePrisma,
  __CELLULOID_RACES_STATE__: state,
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
  const stub = (source) => ({
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  });
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_RACES_PRISMA__;");
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return stub("export async function getSession() { return { user: { id: 'user-1' } }; }");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath(path) { globalThis.__CELLULOID_RACES_STATE__.revalidated.push(path); }");
  }
  if (specifier === "@/lib/tmdb" || normalized.endsWith("/src/lib/tmdb")) {
    return stub(
      "export const MAX_APPENDED_SEASONS = 20;" +
      "export async function getMovie() { throw new Error('unused'); }" +
      "export async function getSeasons() { throw new Error('unused'); }" +
      "export async function getTv() { throw new Error('unused'); }",
    );
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { deleteWatchEvent, toggleTitleTag, updateWatchEvent } = await import("../src/lib/actions");

beforeEach(() => {
  Object.assign(state, {
    upsertError: null,
    deleteError: null,
    updateError: null,
    titleUpdates: [],
    surviving: 0,
    revalidated: [],
  });
});

describe("benign write races (PR-10)", { concurrency: false }, () => {
  it("treats a concurrent tag-on of the same pair as done", async () => {
    state.upsertError = titleTagDuplicate();
    assert.deepEqual(await toggleTitleTag("title-1", "tag-1", true), {});
    assert.ok(state.revalidated.includes("/"));
  });

  it("still throws any other failure to tag a title", async () => {
    // A missing parent is a real error, not a race to ignore.
    state.upsertError = known("P2003", {
      modelName: "TitleTag",
      driverAdapterError: { cause: { constraint: { index: "TitleTag_tagId_fkey" } } },
    });
    await assert.rejects(toggleTitleTag("title-1", "tag-1", true), { code: "P2003" });
    state.upsertError = known("P2002", {
      modelName: "Tag",
      driverAdapterError: { cause: { constraint: { index: "Tag_userId_name_key" } } },
    });
    await assert.rejects(toggleTitleTag("title-1", "tag-1", true), { code: "P2002" });
  });

  it("treats deleting a watch another tab already deleted as done", async () => {
    state.deleteError = watchEventMissing("a delete");
    state.surviving = 2;
    assert.deepEqual(await deleteWatchEvent("event-1"), { ok: true, watchCount: 2 });
    assert.ok(state.revalidated.includes("/"));
  });

  it("still throws any other failure to delete a watch", async () => {
    state.deleteError = known("P2025", { modelName: "Title", operation: "a delete" });
    await assert.rejects(deleteWatchEvent("event-1"), { code: "P2025" });
    state.deleteError = new Error("connection lost");
    await assert.rejects(deleteWatchEvent("event-1"), /connection lost/);
  });

  it("reports editing a watch another tab deleted as not found", async () => {
    state.updateError = watchEventMissing("an update");
    assert.deepEqual(
      await updateWatchEvent("event-1", { occurredAt: "2026-09-02T20:00:00.000Z" }),
      { error: "Watch not found." },
    );
    // Nothing was written, so there's nothing to resync or revalidate.
    assert.deepEqual(state.titleUpdates, []);
    assert.deepEqual(state.revalidated, []);
  });

  it("still throws any other failure to edit a watch", async () => {
    state.updateError = new Error("connection lost");
    await assert.rejects(
      updateWatchEvent("event-1", { occurredAt: "2026-09-02T20:00:00.000Z" }),
      /connection lost/,
    );
  });

  it("edits a watch as before when nothing races", async () => {
    assert.deepEqual(
      await updateWatchEvent("event-1", { occurredAt: "2026-09-02T20:00:00.000Z" }),
      { ok: true },
    );
    assert.ok(state.revalidated.includes("/"));
  });
});
