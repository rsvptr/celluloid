import assert from "node:assert/strict";
import { register } from "node:module";
import { beforeEach, describe, it } from "node:test";

let createdShare: Record<string, unknown> | null = null;
let createdItems: Array<Record<string, unknown>> = [];

const transactionClient = {
  shareList: {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      createdShare = data;
      return { id: "share-1" };
    },
  },
  shareListItem: {
    createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
      createdItems = data;
      return { count: data.length };
    },
  },
};

const prisma = {
  title: {
    findMany: async () => [{ id: "title-1" }],
  },
  shareList: {
    findUnique: async () => null,
  },
  $transaction: async <T>(operation: (tx: typeof transactionClient) => Promise<T>) =>
    operation(transactionClient),
};

Object.assign(globalThis, { __CELLULOID_SHARE_CREATE_PRISMA__: prisma });

const loader = `
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const prisma = globalThis.__CELLULOID_SHARE_CREATE_PRISMA__;",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function getSession() { return { user: { id: 'user-1' } }; }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "next/cache") {
    return {
      url: "data:text/javascript," + encodeURIComponent("export function revalidatePath() {}"),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { createShareList } = await import("../src/lib/share-actions");

beforeEach(() => {
  createdShare = null;
  createdItems = [];
});

describe("share creation storage", { concurrency: false }, () => {
  it("writes curated membership only to ShareListItem", async () => {
    const result = await createShareList({ titleIds: ["title-1"] });

    assert.equal(typeof result.slug, "string");
    assert.ok(createdShare);
    assert.equal(Object.hasOwn(createdShare, "titleIds"), false);
    assert.equal(createdShare.scope, "SELECTION");
    assert.deepEqual(createdItems, [
      { shareListId: "share-1", titleId: "title-1", position: 1 },
    ]);
  });
});
