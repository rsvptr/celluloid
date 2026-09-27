import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import type { EpisodeTypeMarker } from "../src/lib/tmdb-extras";

// Renders the real SeasonTracker, with its server actions and the router
// stubbed, and lets every Suspense boundary resolve.
const loader = `
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const stub = (source) => ({
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  });
  if (specifier === "@/lib/actions" || normalized.endsWith("/src/lib/actions")) {
    return stub(
      "export async function setAllEpisodesWatched() { return {}; }" +
      "export async function setEpisodeWatched() { return {}; }" +
      "export async function setEpisodesWatchedThrough() { return {}; }" +
      "export async function setSeasonWatched() { return {}; }",
    );
  }
  if (specifier === "next/navigation") {
    return stub("export function useRouter() { return { refresh() {}, push() {} }; }");
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { SeasonTracker } = await import("../src/app/(app)/title/[id]/season-tracker");

const episodes = (season: number, count: number, watched: boolean) =>
  Array.from({ length: count }, (_, i) => ({
    id: `s${season}e${i + 1}`,
    episodeNumber: i + 1,
    name: `Episode ${i + 1}`,
    airDate: "2025-01-16T00:00:00.000Z",
    watched,
  }));

// Season 1 is watched, so the tracker opens season 2, the first incomplete one.
const seasons = [
  { id: "season-1", seasonNumber: 1, name: "Season 1", episodes: episodes(1, 9, true) },
  { id: "season-2", seasonNumber: 2, name: "Season 2", episodes: episodes(2, 10, false) },
];

async function render(episodeTypes?: Promise<EpisodeTypeMarker[]>) {
  const { prelude } = await prerender(
    createElement(SeasonTracker, { titleId: "title-1", seasons, episodeTypes }),
  );
  return new Response(prelude).text();
}

/** The label rendered in an episode's row, if any. */
function labelIn(html: string, episodeName: string): string | null {
  const row = html.slice(html.indexOf(`>${episodeName}</span>`), html.indexOf("</li>", html.indexOf(`>${episodeName}</span>`)));
  return row.match(/rounded-full bg-surface-2[^"]*">([^<]+)<\/span>/)?.[1] ?? null;
}

describe("season tracker labels", () => {
  it("labels a season's first episode Premiere and TMDB's finale Season finale", async () => {
    const html = await render(
      Promise.resolve([{ seasonNumber: 2, episodeNumber: 10, type: "finale" as const }]),
    );
    assert.equal(labelIn(html, "Episode 1"), "Premiere");
    assert.equal(labelIn(html, "Episode 10"), "Season finale");
    assert.equal(labelIn(html, "Episode 5"), null);
  });

  it("labels a mid-season finale", async () => {
    const html = await render(
      Promise.resolve([{ seasonNumber: 2, episodeNumber: 5, type: "mid_season" as const }]),
    );
    assert.equal(labelIn(html, "Episode 5"), "Mid-season finale");
  });

  it("still labels premieres with no TMDB data, as for an unmatched title", async () => {
    const html = await render();
    assert.equal(labelIn(html, "Episode 1"), "Premiere");
    assert.equal(labelIn(html, "Episode 10"), null);
  });
});
