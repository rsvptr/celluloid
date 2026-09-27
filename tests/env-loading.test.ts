import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  describeTarget,
  parseArgs,
  resolveTarget,
  main as runBackfill,
} from "../scripts/backfill-discovered-at.mjs";
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
    await assert.rejects(() => runBackfill([], env), /explicit --target dev\|prod is required/);
    await assert.rejects(
      () => runBackfill(["--target", "dev"], env),
      /None of DIRECT_URL, DATABASE_URL_UNPOOLED or DATABASE_URL/,
    );
    await assert.rejects(
      () => runBackfill(["--target=prod", "--yes"], env),
      /PROD_DATABASE_URL is not set/,
    );
    await assert.rejects(() => runBackfill(["--force"], env), /Unknown argument/);
  });

  it("requires exactly one valid --target", () => {
    assert.deepEqual(parseArgs(["--target", "prod", "--yes"]), { target: "prod", yes: true });
    assert.deepEqual(parseArgs(["--target=dev"]), { target: "dev", yes: false });
    assert.throws(() => parseArgs(["--target"]), /either dev or prod/);
    assert.throws(() => parseArgs(["--target", "staging"]), /either dev or prod/);
    assert.throws(() => parseArgs(["--target", "dev", "--target", "prod"]), /only once/);
  });

  it("targets production's direct host through PROD_DATABASE_URL only", () => {
    const env = {
      DATABASE_URL: "postgresql://u:pw@ep-dev-1-pooler.eu-west-2.aws.neon.tech/celluloid",
      DIRECT_URL: "postgresql://u:pw@ep-other-1.eu-west-2.aws.neon.tech/celluloid",
      PROD_DATABASE_URL: "postgresql://u:pw@ep-prod-1-pooler.eu-west-2.aws.neon.tech/celluloid",
    };
    assert.deepEqual(resolveTarget("prod", env), {
      connectionString: "postgresql://u:pw@ep-prod-1.eu-west-2.aws.neon.tech/celluloid",
      label: "PRODUCTION",
      source: "PROD_DATABASE_URL",
    });
    assert.deepEqual(resolveTarget("dev", { DATABASE_URL: env.DATABASE_URL }), {
      connectionString: "postgresql://u:pw@ep-dev-1.eu-west-2.aws.neon.tech/celluloid",
      label: "DEVELOPMENT",
      source: "DATABASE_URL",
    });
  });

  it("refuses before connecting when DIRECT_URL names another Neon branch", async () => {
    const env = {
      NODE_ENV: "test" as const,
      DATABASE_URL: "postgresql://u:pw@ep-dev-1-pooler.eu-west-2.aws.neon.tech/celluloid",
      DIRECT_URL: "postgresql://u:pw@ep-prod-1.eu-west-2.aws.neon.tech/celluloid",
    };
    await assert.rejects(
      () => runBackfill(["--target", "dev", "--yes"], env),
      /Refusing to backfill\. DIRECT_URL/,
    );
  });
});
