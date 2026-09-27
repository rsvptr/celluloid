import assert from "node:assert/strict";
import { register } from "node:module";
import { after, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import type { BackupEnvelope } from "../src/lib/backup-format";
import type { BackupRestorePlan } from "../src/lib/backup";

// PR-02: every case-insensitive tag lookup, run through the real generated
// client and the production pg adapter over a pool that records each query
// instead of connecting. It fails if a call site stops escaping, and if a
// Prisma upgrade stops sending these lookups as an unescaped `ILIKE $n`.

const NAME = "50%_off\\";
const ESCAPED = "50\\%\\_off\\\\";

/** Scripted answers to name lookups, in order; set by each case. */
let lookups: Array<"miss" | "hit"> = [];
let captured: Array<{ text: string; values: unknown[] }> = [];

const COLUMN_VALUES: Record<string, unknown> = {
  id: "row-1",
  userId: "user-1",
  name: "Existing",
  color: null,
  createdAt: "2026-08-04T08:00:00.000+00:00",
};
const TIMESTAMP_OID = 1114;
const TEXT_OID = 25;

function isNameLookup(text: string) {
  return /FROM "(?:public"\.")?Tag"/.test(text) && /WHERE .*"name"/.test(text);
}

/** One result row with whatever columns the SELECT asks for. */
function rowFor(text: string) {
  const list = /^SELECT (.+?) FROM /.exec(text)?.[1] ?? "";
  const names = list
    .split(", ")
    .map((column) => column.split(".").at(-1)!.replaceAll('"', ""));
  return {
    fields: names.map((name) => ({
      name,
      dataTypeID: name === "createdAt" ? TIMESTAMP_OID : TEXT_OID,
    })),
    rows: [names.map((name) => COLUMN_VALUES[name] ?? null)],
    rowCount: 1,
  };
}

const EMPTY = { fields: [], rows: [], rowCount: 0 };

const pool = new pg.Pool();
// PrismaPg only uses the config-object form of query().
pool.query = (async (config: { text: string; values: unknown[] }) => {
  const { text, values } = config;
  captured.push({ text, values });
  if (text.startsWith('INSERT INTO "public"."Tag"')) {
    // Lose the create race, so the P2002 re-read runs too.
    throw Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      severity: "ERROR",
      constraint: "Tag_userId_lower_name_key",
    });
  }
  if (isNameLookup(text)) {
    const answer = lookups.shift();
    assert.ok(answer, `unexpected tag name lookup: ${text}`);
    return answer === "hit" ? rowFor(text) : EMPTY;
  }
  return text.startsWith("SELECT ") ? rowFor(text) : EMPTY;
}) as unknown as typeof pool.query;

const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

Object.assign(globalThis, { __CELLULOID_TAG_LOOKUP_PRISMA__: prisma });
process.env.DATABASE_URL = "postgresql://user:pass@localhost:5432/celluloid_test";
process.env.BETTER_AUTH_SECRET = "tag-lookup-test-secret-not-a-real-value";
process.env.TMDB_ACCESS_TOKEN = "test-tmdb-token";

const mockModules = new Map<string, string>([
  ["@/lib/prisma", "export const prisma = globalThis.__CELLULOID_TAG_LOOKUP_PRISMA__;"],
  [
    "@/lib/session",
    'export async function getSession() { return { user: { id: "user-1" } }; }',
  ],
  ["next/cache", "export function revalidatePath() {}"],
  [
    "@/lib/tmdb",
    "export async function getMovie() { throw new Error('unused'); }\n" +
      "export async function getSeasons() { throw new Error('unused'); }\n" +
      "export const MAX_APPENDED_SEASONS = 20;\n" +
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
  const key = [...modules.keys()].find(
    (name) => specifier === name || normalized.endsWith(name.replace("@/", "/src/")),
  );
  if (key !== undefined) {
    return {
      url: "data:text/javascript," + encodeURIComponent(modules.get(key)),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { bulkRemoveTag, createTag, renameTag } = await import("../src/lib/actions");
const { restoreBackup } = await import("../src/lib/backup");

function assertEscapedLookups(expected: number) {
  const queries = captured.filter((query) => isNameLookup(query.text));
  assert.equal(queries.length, expected);
  assert.deepEqual(lookups, [], "every scripted lookup ran");
  for (const { text, values } of queries) {
    const param = /"name" ILIKE \$(\d+)/.exec(text);
    assert.ok(param, `tag name lookup is not an ILIKE: ${text}`);
    assert.doesNotMatch(text, /ESCAPE/);
    assert.equal(values[Number(param[1]) - 1], ESCAPED);
  }
}

describe("tag name lookups escape ILIKE wildcards", { concurrency: false }, () => {
  beforeEach(() => {
    captured = [];
  });
  after(() => prisma.$disconnect());

  it("findOrCreateTag: lookup and P2002 re-read", async () => {
    lookups = ["miss", "hit"];
    assert.deepEqual(await createTag(NAME), { id: "row-1" });
    assertEscapedLookups(2);
  });

  it("bulkRemoveTag", async () => {
    lookups = ["miss"];
    assert.deepEqual(await bulkRemoveTag(["title-1"], NAME), { count: 0, tag: NAME });
    assertEscapedLookups(1);
  });

  it("renameTag clash check", async () => {
    lookups = ["hit"];
    assert.deepEqual(await renameTag("tag-1", NAME), {
      error: "You already have a tag called “Existing”.",
    });
    assertEscapedLookups(1);
  });

  it("restoreTags: lookup and P2002 re-read", async () => {
    lookups = ["miss", "hit"];
    const backup: BackupEnvelope = {
      app: "celluloid",
      schemaVersion: 2,
      exportedAt: "2026-08-04T08:00:00.000Z",
      user: { timeZone: "UTC", watchRegion: "US", myProviders: [], recommendModel: null },
      titles: [],
      tags: [
        {
          sourceId: "tag-1",
          name: NAME,
          color: null,
          createdAt: "2026-08-04T08:00:00.000Z",
        },
      ],
      shares: [],
      watchEvents: [],
      suppressions: [],
    };
    const counts = {
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
    };
    const plan: BackupRestorePlan = { counts, items: [], stateDigest: "" };
    await restoreBackup("user-1", backup, "merge", plan);
    assertEscapedLookups(2);
  });
});
