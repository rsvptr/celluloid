import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return e.name === "generated" ? [] : sourceFiles(path);
      return /\.(tsx|ts|css)$/.test(e.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

describe("text size floor (JK-26)", () => {
  it("no text is set below 12px", async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await readFile(file, "utf8");
      assert.doesNotMatch(text, /text-\[(?:[0-9]|1[01])px\]/, file);
    }
  });

  it("the column chart's bar area budgets for 16px label lines", async () => {
    const charts = await readFile(join(SRC, "components/charts.tsx"), "utf8");
    assert.match(charts, /const barArea = height - 40;/);
  });
});
