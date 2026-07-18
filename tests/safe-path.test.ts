import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { safeInternalPath } from "../src/app/login/auth-form";

describe("safeInternalPath", () => {
  it("keeps normal internal paths, queries, and hashes", () => {
    assert.equal(safeInternalPath("/"), "/");
    assert.equal(
      safeInternalPath("/library?type=movie#recent"),
      "/library?type=movie#recent",
    );
  });

  it("rejects protocol-relative and absolute URLs", () => {
    assert.equal(safeInternalPath("//evil.example/path"), "/");
    assert.equal(safeInternalPath("https://evil.example/path"), "/");
  });

  it("rejects literal, encoded, and mixed backslash hosts", () => {
    assert.equal(safeInternalPath("/\\evil.example"), "/");
    assert.equal(safeInternalPath("/%5Cevil.example"), "/");
    assert.equal(safeInternalPath("/\\/evil.example"), "/");
    assert.equal(safeInternalPath("/%255Cevil.example"), "/");
  });

  it("rejects controls and malformed encodings", () => {
    assert.equal(safeInternalPath("/library\u0000/settings"), "/");
    assert.equal(safeInternalPath("/library%0A/settings"), "/");
    assert.equal(safeInternalPath("/library/%E0%A4%A"), "/");
  });
});
