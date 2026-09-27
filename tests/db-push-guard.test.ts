import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pushRefusal } from "../scripts/db-push-guard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const guard = `${root}/scripts/db-push-guard.mjs`;

/** Runs the guard with the caller's environment, minus any ALLOW_DB_PUSH it has. */
function runGuard(env: Record<string, string>) {
  return spawnSync(process.execPath, [guard], {
    env: { ...process.env, ALLOW_DB_PUSH: "", ...env },
    encoding: "utf8",
  });
}

describe("db:push guard", () => {
  it("refuses unless ALLOW_DB_PUSH is exactly 1", () => {
    for (const env of [{}, { ALLOW_DB_PUSH: "" }, { ALLOW_DB_PUSH: "0" }, { ALLOW_DB_PUSH: "true" }]) {
      assert.match(pushRefusal(env) ?? "", /db:push refused[\s\S]*npm run db:migrate[\s\S]*ALLOW_DB_PUSH=1/);
    }
    assert.equal(pushRefusal({ ALLOW_DB_PUSH: "1" }), null);
  });

  it("exits 1 without the opt-in and 0 with it", () => {
    const refused = runGuard({});
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /db:push refused/);

    const allowed = runGuard({ ALLOW_DB_PUSH: "1" });
    assert.equal(allowed.status, 0);
    assert.equal(allowed.stderr, "");
  });

  it("runs before prisma db push in the npm script", () => {
    const { scripts } = JSON.parse(readFileSync(`${root}/package.json`, "utf8"));
    assert.match(scripts["db:push"], /^node scripts\/db-push-guard\.mjs && prisma db push && /);
  });
});
