import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  MIGRATION_SQL,
  TAG_INDEX,
  migratedChecks,
  missingObjects,
} from "../scripts/check-migration-objects.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("db:push database-object parity", () => {
  it("guards every migrated CHECK constraint through pg_constraint", async () => {
    const ensureScript = await readFile(`${root}/scripts/ensure-indexes.mjs`, "utf8");
    const names = migratedChecks().map(({ name }) => name);

    assert.equal(names.length, 9);
    assert.equal(new Set(names).size, 9);
    for (const name of names) {
      assert.match(ensureScript, new RegExp(`name: "${name}"`));
    }
    assert.match(ensureScript, /FROM pg_constraint/);
    assert.match(ensureScript, /conrelid = '\"\$\{check\.table\}\"'::regclass/);
  });
});

describe("CI check for migration-only objects", () => {
  const checks = migratedChecks();
  const tagIndex = {
    table: "Tag",
    indexdef: `CREATE UNIQUE INDEX "${TAG_INDEX}" ON public."Tag" USING btree ("userId", lower(name))`,
  };

  it("expects the index the migration creates", async () => {
    assert.match(
      await readFile(MIGRATION_SQL, "utf8"),
      new RegExp(`CREATE UNIQUE INDEX "${TAG_INDEX}" ON "Tag" \\("userId", lower\\("name"\\)\\)`),
    );
  });

  it("passes when every CHECK and the Tag index are present", () => {
    assert.deepEqual(missingObjects(checks, checks, tagIndex), []);
  });

  it("names a dropped CHECK, and one moved to another table", () => {
    const [dropped, moved, ...rest] = checks;
    assert.deepEqual(missingObjects(checks, [{ ...moved, table: "Other" }, ...rest], tagIndex), [
      `CHECK constraint ${dropped.name} on "${dropped.table}"`,
      `CHECK constraint ${moved.name} on "${moved.table}"`,
    ]);
  });

  it("flags a missing, non-unique or case-sensitive Tag index", () => {
    const expected = [`unique index ${TAG_INDEX} on "Tag" ("userId", lower(name))`];
    assert.deepEqual(missingObjects(checks, checks, undefined), expected);
    for (const indexdef of [
      tagIndex.indexdef.replace("UNIQUE ", ""),
      tagIndex.indexdef.replace("lower(name)", "name"),
    ]) {
      assert.deepEqual(missingObjects(checks, checks, { table: "Tag", indexdef }), expected);
    }
  });
});
