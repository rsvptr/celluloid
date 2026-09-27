import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function tsxFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return e.name === "generated" ? [] : tsxFiles(path);
      return e.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("icon scale and stroke (JK-35)", () => {
  it("text-sized icons sit on the 16 / 20 grid", async () => {
    for (const file of await tsxFiles(SRC)) {
      for (const line of (await readFile(file, "utf8")).split("\n")) {
        // Glyphs with their own stroke (checkmarks in fixed boxes) are exempt.
        if (line.includes("strokeWidth")) continue;
        assert.doesNotMatch(line, /size=\{(?:14|15|17|18|19)\}/, `${file}: ${line.trim()}`);
      }
    }
  });

  it("stroke follows the adjacent text weight", async () => {
    const css = await readFile(join(SRC, "app/globals.css"), "utf8");
    assert.match(css, /@layer base \{\s*svg\.lucide\[stroke-width="2"\] \{\s*stroke-width: 1\.5;/);
    assert.match(
      css,
      /:is\(\.font-medium, \.font-semibold, \.font-bold\) > svg\.lucide\[stroke-width="2"\] \{\s*stroke-width: 2;/,
    );
  });
});
