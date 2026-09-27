import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defaultFilter } from "cmdk";
import {
  PALETTE_TITLE_LIMIT,
  paletteTitles,
  paletteTitleValue,
} from "../src/lib/palette-titles";

// VE-14: the palette renders a capped list, but search must still find any
// title in the index, with the matches cmdk found before the cap.

type Entry = { id: string; name: string; year: number | null };

// An alphabetical index, as getTitleIndex returns it, well past the cap.
const index: Entry[] = Array.from({ length: 120 }, (_, i) => ({
  id: `t${i}`,
  name: `Film ${String(i).padStart(3, "0")}`,
  year: 2000 + (i % 20),
}));
const lotr = { id: "lotr", name: "The Lord of the Rings", year: 2001 };
const library = [...index, lotr];

describe("paletteTitles (VE-14)", () => {
  it("shows the first titles in index order when nothing is typed", () => {
    const shown = paletteTitles(library, "");
    assert.equal(shown.length, PALETTE_TITLE_LIMIT);
    assert.deepEqual(shown, library.slice(0, PALETTE_TITLE_LIMIT));
  });

  it("finds a title far past the cap", () => {
    assert.deepEqual(
      paletteTitles(library, "Film 117").map((t) => t.id).slice(0, 1),
      ["t117"],
    );
    assert.deepEqual(paletteTitles(library, "rings").map((t) => t.id), ["lotr"]);
  });

  it("keeps cmdk's fuzzy matching", () => {
    // Not a substring, but cmdk matches it, so the palette always has.
    assert.ok(paletteTitles(library, "lotr").some((t) => t.id === "lotr"));
  });

  it("returns exactly the matches cmdk keeps, best first, capped", () => {
    for (const search of ["film", "fm 2", "2005", "the", "zzz", " "]) {
      const scored = library
        .map((t) => ({ t, score: defaultFilter(paletteTitleValue(t).trim(), search) }))
        .filter((s) => s.score > 0);
      const shown = paletteTitles(library, search);

      assert.equal(shown.length, Math.min(scored.length, PALETTE_TITLE_LIMIT), search);
      const scores = shown.map((t) => defaultFilter(paletteTitleValue(t).trim(), search));
      assert.ok(scores.every((score) => score > 0), search);
      assert.deepEqual(scores, [...scores].sort((a, b) => b - a), search);
      // Nothing left out scores higher than what was kept.
      const floor = Math.min(...scores);
      const kept = new Set(shown);
      assert.ok(
        scored.every((s) => kept.has(s.t) || s.score <= floor),
        search,
      );
    }
  });

  it("matches on the same value the palette gives each item", () => {
    assert.equal(paletteTitleValue({ name: "Heat", year: 1995 }), "Heat 1995");
    assert.equal(paletteTitleValue({ name: "Heat", year: null }), "Heat ");
  });
});
