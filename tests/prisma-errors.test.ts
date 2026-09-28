import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma } from "../src/generated/prisma/client";
import { isRecordNotFound, isUniqueViolation } from "../src/lib/prisma-errors";

// The meta shapes below are what Prisma 7.10 with @prisma/adapter-pg raised
// against Postgres (PGlite with every migration): a TitleTag upsert racing an
// insert of the same pair, and a watch event update/delete by a missing id.
function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("test", {
    code,
    clientVersion: "7.10.0",
    meta,
  });
}

function uniqueOn(modelName: string, constraint: unknown) {
  return known("P2002", {
    modelName,
    driverAdapterError: {
      name: "DriverAdapterError",
      cause: {
        originalCode: "23505",
        kind: "UniqueConstraintViolation",
        constraint,
        table: modelName,
      },
    },
  });
}

describe("isUniqueViolation (PR-10)", () => {
  it("matches a P2002 of the named constraint on the named model", () => {
    assert.equal(
      isUniqueViolation(uniqueOn("TitleTag", { index: "TitleTag_pkey" }), "TitleTag", "TitleTag_pkey"),
      true,
    );
  });

  it("rejects any other model, constraint or code", () => {
    const pair = uniqueOn("TitleTag", { index: "TitleTag_pkey" });
    assert.equal(isUniqueViolation(pair, "Tag", "TitleTag_pkey"), false);
    assert.equal(isUniqueViolation(pair, "TitleTag", "Tag_userId_name_key"), false);
    assert.equal(
      isUniqueViolation(uniqueOn("TitleTag", { fields: ["titleId", "tagId"] }), "TitleTag", "TitleTag_pkey"),
      false,
    );
    assert.equal(
      isUniqueViolation(
        known("P2003", {
          modelName: "TitleTag",
          driverAdapterError: { cause: { constraint: { index: "TitleTag_pkey" } } },
        }),
        "TitleTag",
        "TitleTag_pkey",
      ),
      false,
    );
    assert.equal(isUniqueViolation(known("P2002"), "TitleTag", "TitleTag_pkey"), false);
    assert.equal(isUniqueViolation(new Error("P2002"), "TitleTag", "TitleTag_pkey"), false);
    assert.equal(isUniqueViolation(undefined, "TitleTag", "TitleTag_pkey"), false);
  });
});

describe("isRecordNotFound (PR-10)", () => {
  it("matches a P2025 on the named model", () => {
    assert.equal(
      isRecordNotFound(known("P2025", { modelName: "WatchEvent", operation: "a delete" }), "WatchEvent"),
      true,
    );
    assert.equal(
      isRecordNotFound(known("P2025", { modelName: "WatchEvent", operation: "an update" }), "WatchEvent"),
      true,
    );
  });

  it("rejects any other model or code", () => {
    assert.equal(
      isRecordNotFound(known("P2025", { modelName: "Title", operation: "an update" }), "WatchEvent"),
      false,
    );
    assert.equal(isRecordNotFound(known("P2025"), "WatchEvent"), false);
    assert.equal(
      isRecordNotFound(uniqueOn("WatchEvent", { index: "WatchEvent_pkey" }), "WatchEvent"),
      false,
    );
    assert.equal(isRecordNotFound(new Error("P2025"), "WatchEvent"), false);
    assert.equal(isRecordNotFound(null, "WatchEvent"), false);
  });
});
