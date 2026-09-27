import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tagNameFilter } from "../src/lib/tag-name";

describe("tagNameFilter", () => {
  it("escapes the ILIKE wildcards and the escape character", () => {
    assert.deepEqual(tagNameFilter("50%_off\\"), {
      equals: "50\\%\\_off\\\\",
      mode: "insensitive",
    });
    assert.equal(tagNameFilter("100%").equals, "100\\%");
    assert.equal(tagNameFilter("to_watch").equals, "to\\_watch");
    assert.equal(tagNameFilter("%").equals, "\\%");
    assert.equal(tagNameFilter("a\\b").equals, "a\\\\b");
    assert.equal(tagNameFilter("__%%\\\\").equals, "\\_\\_\\%\\%\\\\\\\\");
  });

  it("leaves ordinary names unchanged", () => {
    for (const name of ["Horror", "to watch", "sci-fi", "Amélie", "80s + 90s", ""]) {
      assert.deepEqual(tagNameFilter(name), { equals: name, mode: "insensitive" });
    }
  });
});
