import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("status badge over posters (JK-01)", () => {
  it("sits on an opaque chip instead of the translucent status tint", async () => {
    const card = await source("../src/components/title-card.tsx");
    const overlay = card.slice(
      card.indexOf('<span className="absolute left-1.5 top-1.5">'),
      card.indexOf("</Badge>"),
    );
    // bg-black/75 last, so cn/tailwind-merge drops the status bg-*/15 tint
    // while keeping the status text color.
    assert.match(overlay, /<Badge className=\{cn\(status\.badge, "bg-black\/75"\)\}>/);
  });
});
