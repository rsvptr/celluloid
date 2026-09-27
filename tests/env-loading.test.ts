import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { describeTarget, main as runBackfill } from "../scripts/backfill-discovered-at.mjs";
import { loadEnv } from "../scripts/load-env.mjs";

describe("operator environment loading", () => {
  it("keeps process values, then prefers .env.local over .env", () => {
    const directory = mkdtempSync(join(tmpdir(), "celluloid-env-"));
    try {
      writeFileSync(
        join(directory, ".env"),
        "FROM_ENV=base\nSHARED=base\nPROCESS_VALUE=from-file\n",
      );
      writeFileSync(join(directory, ".env.local"), "FROM_LOCAL=local\nSHARED=local\n");
      const processEnv = { NODE_ENV: "test" as const, PROCESS_VALUE: "from-process" };

      loadEnv({ cwd: directory, processEnv });

      assert.deepEqual(processEnv, {
        NODE_ENV: "test",
        PROCESS_VALUE: "from-process",
        FROM_LOCAL: "local",
        SHARED: "local",
        FROM_ENV: "base",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("discovered-at backfill guardrails", () => {
  it("describes a target without credentials or query parameters", () => {
    assert.equal(
      describeTarget("postgresql://owner:secret@db.example.test:5432/celluloid?sslmode=require"),
      "db.example.test:5432/celluloid",
    );
    assert.throws(() => describeTarget("https://db.example.test/celluloid"), /PostgreSQL/);
  });

  it("fails before connecting when configuration or arguments are invalid", async () => {
    const env = { NODE_ENV: "test" as const };
    await assert.rejects(
      () => runBackfill([], env),
      /None of DIRECT_URL, DATABASE_URL_UNPOOLED or DATABASE_URL/,
    );
    await assert.rejects(() => runBackfill(["--force"], env), /Unknown argument/);
  });

  it("refuses before connecting when DIRECT_URL names another Neon branch", async () => {
    const env = {
      NODE_ENV: "test" as const,
      DATABASE_URL: "postgresql://u:pw@ep-dev-1-pooler.eu-west-2.aws.neon.tech/celluloid",
      DIRECT_URL: "postgresql://u:pw@ep-prod-1.eu-west-2.aws.neon.tech/celluloid",
    };
    await assert.rejects(() => runBackfill(["--yes"], env), /Refusing to backfill\. DIRECT_URL/);
  });
});
