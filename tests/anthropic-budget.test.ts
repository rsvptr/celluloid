import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSharedAiDailyRunLimit,
  releaseSharedAiRun,
  reserveSharedAiRun,
  sharedAiUtcDay,
  type SharedAiRunReserver,
  type SharedAiRunReleaser,
} from "../src/lib/anthropic";

const NOW = new Date("2026-08-29T23:59:59.999Z");

describe("shared AI daily run limit", () => {
  it("treats an unset or blank limit as uncapped", async () => {
    let calls = 0;
    const reserve: SharedAiRunReserver = async () => {
      calls += 1;
      return 1;
    };

    assert.equal(parseSharedAiDailyRunLimit(undefined), null);
    assert.equal(parseSharedAiDailyRunLimit("   "), null);
    assert.deepEqual(await reserveSharedAiRun("", NOW, reserve), {
      allowed: true,
      day: null,
      limit: null,
      runCount: null,
    });
    assert.equal(calls, 0);
  });

  it("accepts positive whole numbers and rejects unsafe configuration", () => {
    assert.equal(parseSharedAiDailyRunLimit("20"), 20);
    assert.equal(parseSharedAiDailyRunLimit(" 004 "), 4);
    for (const value of ["0", "-1", "1.5", "many", "2147483648"]) {
      assert.throws(() => parseSharedAiDailyRunLimit(value), /SHARED_AI_DAILY_RUN_LIMIT/);
    }
  });

  it("keys reservations to the UTC calendar day", () => {
    assert.equal(sharedAiUtcDay(NOW), "2026-08-29");
    assert.equal(sharedAiUtcDay(new Date("2026-08-30T00:00:00.000Z")), "2026-08-30");
  });

  it("allows only the atomically reserved runs", async () => {
    let count = 0;
    const reserve: SharedAiRunReserver = async (_day, limit) => {
      if (count >= limit) return null;
      count += 1;
      return count;
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveSharedAiRun("3", NOW, reserve)),
    );

    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.deepEqual(
      results.filter((result) => result.allowed).map((result) => result.runCount),
      [1, 2, 3],
    );
    assert.equal(results.filter((result) => !result.allowed).length, 5);
    assert.ok(
      results.every((result) => result.day === "2026-08-29" && result.limit === 3),
    );
  });

  it("releases only a counted shared-key reservation", async () => {
    const days: string[] = [];
    const release: SharedAiRunReleaser = async (day) => {
      days.push(day);
    };

    await releaseSharedAiRun(null, release);
    await releaseSharedAiRun("2026-08-29", release);

    assert.deepEqual(days, ["2026-08-29"]);
  });
});
