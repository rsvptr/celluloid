import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { neonEndpointId, resolveMigrationTarget, toDirectUrl } from "../scripts/db-urls.mjs";

const DEV_POOLED =
  "postgresql://owner:p%40ss%2Fw%3Ard@ep-dev-branch-a1b2c3-pooler.eu-west-2.aws.neon.tech/celluloid?sslmode=require&channel_binding=require";
const DEV_DIRECT =
  "postgresql://owner:p%40ss%2Fw%3Ard@ep-dev-branch-a1b2c3.eu-west-2.aws.neon.tech/celluloid?sslmode=require&channel_binding=require";
const PROD_POOLED =
  "postgresql://owner:prodsecret@ep-prod-main-z9y8x7-pooler.eu-west-2.aws.neon.tech/celluloid?sslmode=require";
const PROD_DIRECT =
  "postgresql://owner:prodsecret@ep-prod-main-z9y8x7.eu-west-2.aws.neon.tech/celluloid?sslmode=require";
const LOCAL = "postgresql://postgres:postgres@localhost:5432/celluloid";

function password(url: string) {
  return decodeURIComponent(new URL(url).password);
}

describe("toDirectUrl", () => {
  it("strips -pooler from a Neon host and keeps credentials, database and query params", () => {
    assert.equal(toDirectUrl(DEV_POOLED), DEV_DIRECT);
    assert.equal(password(toDirectUrl(DEV_POOLED)), "p@ss/w:rd");
  });

  it("keeps the port, and matches the host case-insensitively without lowercasing it", () => {
    assert.equal(
      toDirectUrl("postgres://u:pw@EP-Cool-Dark-123-POOLER.us-east-2.aws.neon.tech:5432/neondb"),
      "postgres://u:pw@EP-Cool-Dark-123.us-east-2.aws.neon.tech:5432/neondb",
    );
  });

  it("handles hosts with an extra cell label before the region", () => {
    assert.equal(
      toDirectUrl("postgresql://u:pw@ep-a-b-1-pooler.c-2.us-east-1.aws.neon.tech/db"),
      "postgresql://u:pw@ep-a-b-1.c-2.us-east-1.aws.neon.tech/db",
    );
  });

  it("preserves the decoded password when the original leaves reserved characters raw", () => {
    const raw = "postgresql://u:p;w=x@ep-x-pooler.eu-west-2.aws.neon.tech/db";
    const direct = toDirectUrl(raw);
    assert.equal(new URL(direct).hostname, "ep-x.eu-west-2.aws.neon.tech");
    assert.equal(password(direct), password(raw));
  });

  it("returns direct Neon, non-Neon and unparseable strings unchanged", () => {
    for (const url of [
      DEV_DIRECT,
      LOCAL,
      "postgresql://u:pw@my-pooler.example.com/db",
      "postgresql:///db?host=/var/run/postgresql",
      "not a url",
    ]) {
      assert.equal(toDirectUrl(url), url);
    }
    assert.equal(toDirectUrl(""), "");
    assert.equal(toDirectUrl(undefined), undefined);
  });
});

describe("neonEndpointId", () => {
  it("is the same for a branch's pooled and direct hosts", () => {
    assert.equal(neonEndpointId(DEV_POOLED), "ep-dev-branch-a1b2c3");
    assert.equal(neonEndpointId(DEV_DIRECT), "ep-dev-branch-a1b2c3");
  });

  it("is null for anything that is not a Neon endpoint host", () => {
    assert.equal(neonEndpointId(LOCAL), null);
    assert.equal(neonEndpointId("postgresql://u:pw@ep-x.example.com/db"), null);
    assert.equal(neonEndpointId("not a url"), null);
    assert.equal(neonEndpointId(undefined), null);
  });
});

describe("resolveMigrationTarget precedence", () => {
  it("prefers DIRECT_URL, then DATABASE_URL_UNPOOLED, then the direct form of DATABASE_URL", () => {
    assert.deepEqual(
      resolveMigrationTarget({
        DIRECT_URL: DEV_DIRECT,
        DATABASE_URL_UNPOOLED: DEV_DIRECT.replace("owner", "other"),
        DATABASE_URL: DEV_POOLED,
      }),
      { url: DEV_DIRECT, source: "DIRECT_URL", mismatch: null },
    );
    assert.deepEqual(
      resolveMigrationTarget({ DATABASE_URL_UNPOOLED: DEV_DIRECT, DATABASE_URL: DEV_POOLED }),
      { url: DEV_DIRECT, source: "DATABASE_URL_UNPOOLED", mismatch: null },
    );
    assert.deepEqual(resolveMigrationTarget({ DATABASE_URL: DEV_POOLED }), {
      url: DEV_DIRECT,
      source: "DATABASE_URL",
      mismatch: null,
    });
  });

  it("converts a pooled DIRECT_URL or DATABASE_URL_UNPOOLED to the direct host", () => {
    assert.deepEqual(resolveMigrationTarget({ DIRECT_URL: DEV_POOLED, DATABASE_URL: DEV_POOLED }), {
      url: DEV_DIRECT,
      source: "DIRECT_URL",
      mismatch: null,
    });
    assert.deepEqual(resolveMigrationTarget({ DATABASE_URL_UNPOOLED: PROD_POOLED }), {
      url: PROD_DIRECT,
      source: "DATABASE_URL_UNPOOLED",
      mismatch: null,
    });
  });

  it("lets a blank variable fall through instead of handing Prisma an empty URL (PR-13)", () => {
    assert.deepEqual(
      resolveMigrationTarget({ DIRECT_URL: "", DATABASE_URL_UNPOOLED: "", DATABASE_URL: DEV_POOLED }),
      { url: DEV_DIRECT, source: "DATABASE_URL", mismatch: null },
    );
  });

  it("returns no URL when nothing is set", () => {
    assert.deepEqual(resolveMigrationTarget({}), {
      url: undefined,
      source: undefined,
      mismatch: null,
    });
  });

  it("passes non-Neon URLs through, as CI's local Postgres needs", () => {
    assert.deepEqual(resolveMigrationTarget({ DATABASE_URL: LOCAL, DIRECT_URL: LOCAL }), {
      url: LOCAL,
      source: "DIRECT_URL",
      mismatch: null,
    });
    assert.deepEqual(resolveMigrationTarget({ DATABASE_URL: LOCAL }), {
      url: LOCAL,
      source: "DATABASE_URL",
      mismatch: null,
    });
  });

  it("reads process.env by default", () => {
    const saved = { ...process.env };
    try {
      delete process.env.DIRECT_URL;
      delete process.env.DATABASE_URL_UNPOOLED;
      process.env.DATABASE_URL = PROD_POOLED;
      assert.equal(resolveMigrationTarget().url, PROD_DIRECT);
    } finally {
      for (const key of ["DIRECT_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("resolveMigrationTarget same-endpoint guard (NE-06)", () => {
  it("flags a DIRECT_URL on another branch, naming endpoints but no credentials", () => {
    const { url, source, mismatch } = resolveMigrationTarget({
      DIRECT_URL: PROD_DIRECT,
      DATABASE_URL: DEV_POOLED,
    });
    assert.equal(url, PROD_DIRECT);
    assert.equal(source, "DIRECT_URL");
    assert.match(mismatch ?? "", /DIRECT_URL points at Neon endpoint ep-prod-main-z9y8x7/);
    assert.match(mismatch ?? "", /DATABASE_URL points at Neon endpoint ep-dev-branch-a1b2c3/);
    assert.doesNotMatch(mismatch ?? "", /prodsecret|p%40ss|owner/);
  });

  it("flags an ambient DATABASE_URL_UNPOOLED that outranks a repointed DATABASE_URL", () => {
    // e.g. `vercel env pull` wrote the dev branch's unpooled string, then an
    // operator overrode only DATABASE_URL to reach production.
    const { source, mismatch } = resolveMigrationTarget({
      DATABASE_URL_UNPOOLED: DEV_DIRECT,
      DATABASE_URL: PROD_POOLED,
    });
    assert.equal(source, "DATABASE_URL_UNPOOLED");
    assert.match(mismatch ?? "", /DATABASE_URL_UNPOOLED points at Neon endpoint ep-dev-branch-a1b2c3/);
  });

  it("flags a Neon URL paired with a non-Neon one, in either direction", () => {
    assert.match(
      resolveMigrationTarget({ DIRECT_URL: PROD_DIRECT, DATABASE_URL: LOCAL }).mismatch ?? "",
      /DATABASE_URL points at an unparseable or non-Neon URL/,
    );
    assert.match(
      resolveMigrationTarget({ DIRECT_URL: LOCAL, DATABASE_URL: DEV_POOLED }).mismatch ?? "",
      /DIRECT_URL points at an unparseable or non-Neon URL/,
    );
  });

  it("accepts the pooled and direct strings of one branch, in any host case", () => {
    assert.equal(
      resolveMigrationTarget({
        DIRECT_URL: DEV_DIRECT.replace(/ep-[^/]+/, (host) => host.toUpperCase()),
        DATABASE_URL: DEV_POOLED,
      }).mismatch,
      null,
    );
  });

  it("flags another database on the same endpoint, naming both databases", () => {
    const mismatch = resolveMigrationTarget({
      DIRECT_URL: DEV_DIRECT.replace("/celluloid?", "/neondb?"),
      DATABASE_URL: DEV_POOLED,
    }).mismatch;
    assert.match(
      mismatch ?? "",
      /DIRECT_URL points at database "neondb" on Neon endpoint ep-dev-branch-a1b2c3, but DATABASE_URL points at database "celluloid"/,
    );
    assert.doesNotMatch(mismatch ?? "", /p%40ss|owner/);
    assert.match(
      resolveMigrationTarget({
        DATABASE_URL_UNPOOLED: DEV_DIRECT.replace("/celluloid?", "?"),
        DATABASE_URL: DEV_POOLED,
      }).mismatch ?? "",
      /DATABASE_URL_UNPOOLED points at the role's default database/,
    );
  });

  it("compares decoded database names and ignores the role", () => {
    assert.equal(
      resolveMigrationTarget({
        DIRECT_URL: DEV_DIRECT.replace("owner:", "migrator:").replace("/celluloid?", "/cellul%6Fid?"),
        DATABASE_URL: DEV_POOLED,
      }).mismatch,
      null,
    );
  });

  it("skips the comparison when DATABASE_URL is unset or both hosts are non-Neon", () => {
    assert.equal(resolveMigrationTarget({ DIRECT_URL: PROD_DIRECT }).mismatch, null);
    assert.equal(
      resolveMigrationTarget({ DIRECT_URL: LOCAL, DATABASE_URL: "postgresql://u:pw@127.0.0.1/x" })
        .mismatch,
      null,
    );
  });

  it("only guards the variable actually chosen", () => {
    // A stray DATABASE_URL_UNPOOLED is irrelevant while DIRECT_URL outranks it.
    assert.equal(
      resolveMigrationTarget({
        DIRECT_URL: DEV_DIRECT,
        DATABASE_URL_UNPOOLED: PROD_DIRECT,
        DATABASE_URL: DEV_POOLED,
      }).mismatch,
      null,
    );
  });
});

describe("prisma.config.ts datasource", () => {
  // Blank values, not deletions: loadEnv never overrides a key that exists,
  // so a developer's .env.local can't fill them in.
  let loads = 0;
  async function loadConfig(t: TestContext, env: Record<string, string>) {
    const saved = { ...process.env };
    const errors: string[] = [];
    t.mock.method(console, "error", (message: string) => errors.push(message));
    Object.assign(process.env, { DIRECT_URL: "", DATABASE_URL_UNPOOLED: "", ...env });
    try {
      const { default: config } = await import(`../prisma.config.ts?load=${(loads += 1)}`);
      return { url: config.datasource?.url, errors };
    } finally {
      for (const key of ["DIRECT_URL", "DATABASE_URL_UNPOOLED", "DATABASE_URL"]) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }

  it("withholds the URL when the migration target mismatches", async (t) => {
    const { url, errors } = await loadConfig(t, {
      DIRECT_URL: DEV_DIRECT.replace("/celluloid?", "/neondb?"),
      DATABASE_URL: DEV_POOLED,
    });
    assert.equal(url, undefined);
    assert.match(errors.join("\n"), /No datasource URL was passed to Prisma/);
  });

  it("passes the direct URL when the target matches", async (t) => {
    const { url, errors } = await loadConfig(t, { DIRECT_URL: DEV_POOLED, DATABASE_URL: DEV_POOLED });
    assert.equal(url, DEV_DIRECT);
    assert.deepEqual(errors, []);
  });
});
