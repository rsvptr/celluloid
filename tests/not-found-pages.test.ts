import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("not-found pages (JK-19)", () => {
  it("a dead share link explains itself without a library link", async () => {
    const page = await source("../src/app/s/[slug]/not-found.tsx");
    assert.match(page, /<main[\s>]/);
    assert.match(page, /This shared list isn&apos;t available/);
    assert.match(page, /Ask the person who shared it/);
    assert.doesNotMatch(page, /<Link|href="\/"/);
  });

  it("the global not-found page has a <main>", async () => {
    const page = await source("../src/app/not-found.tsx");
    assert.match(page, /<main[\s>]/);
    assert.doesNotMatch(page, /We couldn/);
  });
});
