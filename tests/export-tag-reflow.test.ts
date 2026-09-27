import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ExportPanel } from "../src/app/(app)/export/export-panel";
import type { ExportRow } from "../src/lib/export/format";

const LONG_TAG = "Films my book club argued about for three straight weeks";

const ROW: ExportRow = {
  id: "t1",
  tmdbId: null,
  name: "Title 1",
  mediaType: "movie",
  year: 2020,
  releaseDate: "2020-01-01",
  languageCode: "en",
  language: "English",
  statusKey: "WATCHED",
  status: "Watched",
  myRating: null,
  tmdbRating: 7,
  genres: ["Drama"],
  totalEpisodes: null,
  watchedEpisodes: 0,
  watchCount: 0,
  favorite: false,
  notes: null,
  tags: [LONG_TAG],
  watchedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

// JK-13: the Select primitive sizes to its content, so a long tag name pushed
// the Export page to 431px at a 320px viewport. The Tag select is capped to its
// label, which may shrink below its content, and the title keeps the chosen
// name readable.
describe("Export tag select at 320px (JK-13)", () => {
  const html = renderToStaticMarkup(
    createElement(ExportPanel, {
      rows: [ROW],
      tags: [LONG_TAG],
      initialScope: { tag: LONG_TAG },
      rememberFilters: false,
    }),
  );
  const label = html.match(/<label class="([^"]*)"><span[^>]*>Tag<\/span>(<select[^>]*>)/);

  it("lets the Tag label shrink below its content", () => {
    assert.ok(label, "Tag label not rendered");
    assert.match(label[1], /(^| )min-w-0( |$)/);
  });

  it("caps the select to the label and titles it with the chosen tag", () => {
    const select = label?.[2] ?? "";
    assert.match(select, /class="[^"]*(?<![\w:-])w-full(?![\w-])/);
    assert.match(select, new RegExp(`title="${LONG_TAG}"`));
  });
});
