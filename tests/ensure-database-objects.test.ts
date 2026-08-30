import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("db:push database-object parity", () => {
  it("guards every migrated CHECK constraint through pg_constraint", async () => {
    const [migration, ensureScript] = await Promise.all([
      readFile(
        `${root}/prisma/migrations/20260717221157_workflow_foundation/migration.sql`,
        "utf8",
      ),
      readFile(`${root}/scripts/ensure-indexes.mjs`, "utf8"),
    ]);
    const migratedChecks = [...migration.matchAll(/ADD CONSTRAINT "([^"]+_check)"/g)].map(
      ([, name]) => name,
    );

    assert.equal(migratedChecks.length, 9);
    assert.equal(new Set(migratedChecks).size, 9);
    for (const name of migratedChecks) {
      assert.match(ensureScript, new RegExp(`name: "${name}"`));
    }
    assert.match(ensureScript, /FROM pg_constraint/);
    assert.match(ensureScript, /conrelid = '\"\$\{check\.table\}\"'::regclass/);
  });
});
