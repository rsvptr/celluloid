import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveMigrationTarget } from "../scripts/db-urls.mjs";
import {
  describeTarget,
  pendingMigrations,
  prodMigrationEnv,
  sameEndpointWarning,
} from "../scripts/deploy-prod-migrations.mjs";
import { loadEnv } from "../scripts/load-env.mjs";

const PROD_POOLED =
  "postgresql://owner:prodsecret@ep-prod-main-z9y8x7-pooler.eu-west-2.aws.neon.tech/celluloid?sslmode=require";
const PROD_DIRECT =
  "postgresql://owner:prodsecret@ep-prod-main-z9y8x7.eu-west-2.aws.neon.tech/celluloid?sslmode=require";
const DEV_POOLED = "postgresql://owner:devsecret@ep-dev-branch-a1b2c3-pooler.eu-west-2.aws.neon.tech/celluloid";
const DEV_DIRECT = "postgresql://owner:devsecret@ep-dev-branch-a1b2c3.eu-west-2.aws.neon.tech/celluloid";

describe("deploy-prod-migrations child environment", () => {
  it("pins DATABASE_URL to PROD_DATABASE_URL and DIRECT_URL to its direct form", () => {
    const env = prodMigrationEnv(PROD_POOLED, { PATH: "/bin", DATABASE_URL: DEV_POOLED });
    assert.equal(env.PATH, "/bin");
    assert.equal(env.DATABASE_URL, PROD_POOLED);
    assert.equal(env.DIRECT_URL, PROD_DIRECT);
    assert.equal(prodMigrationEnv(PROD_DIRECT, {}).DIRECT_URL, PROD_DIRECT);
  });

  it("resolves to production's direct URL in the child even with the dev branch in .env.local", () => {
    const directory = mkdtempSync(join(tmpdir(), "celluloid-deploy-"));
    try {
      writeFileSync(
        join(directory, ".env.local"),
        `DATABASE_URL="${DEV_POOLED}"\nDIRECT_URL="${DEV_DIRECT}"\nDATABASE_URL_UNPOOLED="${DEV_DIRECT}"\n`,
      );
      // The parent loads .env.local, builds the child env, and prisma.config.ts
      // in the child loads .env.local again before resolving.
      const parentEnv = { NODE_ENV: "test" as const };
      loadEnv({ cwd: directory, processEnv: parentEnv });
      const childEnv = { ...prodMigrationEnv(PROD_POOLED, parentEnv), NODE_ENV: "test" as const };
      loadEnv({ cwd: directory, processEnv: childEnv });

      assert.deepEqual(resolveMigrationTarget(childEnv), {
        url: PROD_DIRECT,
        source: "DIRECT_URL",
        mismatch: null,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("needs DATABASE_URL pinned too: overriding only DIRECT_URL trips the same-branch guard", () => {
    const onlyDirect = { DATABASE_URL: DEV_POOLED, DIRECT_URL: PROD_DIRECT };
    assert.match(resolveMigrationTarget(onlyDirect).mismatch ?? "", /different database/);
  });
});

describe("deploy-prod-migrations target description", () => {
  it("shows the endpoint id, host and database without credentials or params", () => {
    const target = describeTarget(PROD_DIRECT);
    assert.deepEqual(target, {
      endpoint: "ep-prod-main-z9y8x7",
      host: "ep-prod-main-z9y8x7.eu-west-2.aws.neon.tech",
      database: "celluloid",
    });
    assert.doesNotMatch(JSON.stringify(target), /prodsecret|owner|sslmode/);
  });

  it("labels non-Neon and unparseable targets instead of failing", () => {
    assert.deepEqual(describeTarget("postgresql://u:pw@db.example.test:5432/"), {
      endpoint: "(not a Neon host)",
      host: "db.example.test:5432",
      database: "(the role's default database)",
    });
    assert.equal(describeTarget("not a url").endpoint, "(unparseable connection string)");
  });
});

describe("deploy-prod-migrations same-endpoint warning", () => {
  it("warns when both variables name one endpoint, pooled or direct, without printing credentials", () => {
    for (const [prod, app] of [
      [PROD_POOLED, PROD_DIRECT],
      [PROD_DIRECT, PROD_POOLED],
      [DEV_POOLED, DEV_DIRECT],
    ]) {
      const warning = sameEndpointWarning(prod, app);
      assert.match(warning ?? "", /both point at Neon endpoint ep-(prod-main-z9y8x7|dev-branch-a1b2c3)\./);
      assert.doesNotMatch(warning ?? "", /secret|owner@|sslmode/);
    }
  });

  it("stays quiet for different endpoints, non-Neon or unparseable values, and a missing DATABASE_URL", () => {
    assert.equal(sameEndpointWarning(PROD_POOLED, DEV_POOLED), null);
    assert.equal(sameEndpointWarning(PROD_DIRECT, DEV_DIRECT), null);
    assert.equal(sameEndpointWarning(PROD_POOLED, undefined), null);
    assert.equal(sameEndpointWarning(PROD_POOLED, "postgresql://u:pw@localhost:5432/celluloid"), null);
    assert.equal(sameEndpointWarning("postgresql://u:pw@localhost:5432/a", "postgresql://u:pw@localhost:5432/a"), null);
    assert.equal(sameEndpointWarning("not a url", "not a url"), null);
  });
});

describe("deploy-prod-migrations pending list", () => {
  const local = [
    "20260717221157_workflow_foundation",
    "20260930120000_add_widgets",
    "20261001090000_drop_gadgets",
  ];

  it("reads the folders listed as not yet applied", () => {
    const output = [
      "Loaded Prisma config from prisma.config.ts.",
      'Datasource "db": PostgreSQL database "celluloid", schema "public" at "ep-prod-main-z9y8x7.eu-west-2.aws.neon.tech"',
      "",
      "3 migrations found in prisma/migrations",
      "Following migrations have not yet been applied:",
      "20260930120000_add_widgets",
      "20261001090000_drop_gadgets",
      "",
      "To apply migrations in development run prisma migrate dev.",
      "To apply migrations in production run prisma migrate deploy.",
    ].join("\n");
    assert.deepEqual(pendingMigrations(output, local), [
      "20260930120000_add_widgets",
      "20261001090000_drop_gadgets",
    ]);
  });

  it("reads the unapplied list when histories diverge, not the database-only folders", () => {
    const output = [
      "Your local migration history and the migrations table from your database are different:",
      "",
      "The last common migration is: 20260717221157_workflow_foundation",
      "",
      "The migration have not yet been applied:",
      "20260930120000_add_widgets",
      "",
      "The migration from the database are not found locally in prisma/migrations:",
      "20260920000000_hotfix_elsewhere",
    ].join("\r\n");
    assert.deepEqual(pendingMigrations(output, local), ["20260930120000_add_widgets"]);
  });

  it("finds nothing when up to date, on errors, or for failed migrations", () => {
    assert.deepEqual(
      pendingMigrations("3 migrations found in prisma/migrations\n\nDatabase schema is up to date!", local),
      [],
    );
    assert.deepEqual(pendingMigrations("Error: P1001: Can't reach database server", local), []);
    assert.deepEqual(
      pendingMigrations("Following migration have failed:\n20261001090000_drop_gadgets\n", local),
      [],
    );
  });

  it("ignores listed names that are not local folders", () => {
    assert.deepEqual(
      pendingMigrations("Following migration have not yet been applied:\nsomething else\n", local),
      [],
    );
  });
});
