import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { TitleBundle } from "../src/lib/tmdb";
import type { RegionalRelease } from "../src/lib/tmdb-extras";
import { RegionalReleases } from "../src/app/(app)/title/[id]/regional-releases";

async function render(releases: RegionalRelease[] | null, region: string) {
  const bundle = Promise.resolve(releases && ({ releases } as unknown as TitleBundle));
  const element = await RegionalReleases({ bundle, region });
  return element ? renderToStaticMarkup(element as ReactElement) : "";
}

describe("regional release dates on the title page", () => {
  it("says when a film is in cinemas in the viewer's region, digitally and on disc", async () => {
    const html = await render(
      [
        { type: 3, date: "2024-02-15T00:00:00.000Z" },
        { type: 4, date: "2024-03-15T00:00:00.000Z" },
        { type: 5, date: "2024-06-01T00:00:00.000Z" },
      ],
      "IN",
    );
    assert.equal(
      html,
      '<p class="text-sm text-muted">In cinemas in India on February 15, 2024 · ' +
        "Digital on March 15, 2024 · On disc on June 1, 2024</p>",
    );
  });

  it("renders nothing without dates for the region, or when TMDB failed", async () => {
    assert.equal(await render([], "US"), "");
    assert.equal(await render(null, "US"), "");
  });
});
