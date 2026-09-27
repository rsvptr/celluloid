import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { CardItem } from "../src/components/title-card";

// next/image is a CommonJS module exporting `default` under __esModule, which
// plain Node's ESM interop doesn't unwrap (Next's bundler does), so re-export
// the real component from an ESM shim. The App Router Link can't load outside
// Next at all (it needs the RSC client), so next/link becomes a bare <a>: these
// tests cover the card's own markup, not Link. `register`, not `registerHooks`,
// for the same @types/node reason as tests/backup.test.ts.
const hooks = `
const shim = (source) => ({ url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true });
export async function resolve(specifier, context, nextResolve) {
  const url = async (s) => JSON.stringify((await nextResolve(s, context)).url);
  if (specifier === "next/image") {
    return shim("import m from " + (await url("next/dist/shared/lib/image-external.js")) + "; export default m.default;");
  }
  if (specifier === "next/link") {
    return shim("import { createElement } from " + (await url("react")) +
      "; export default function Link({ prefetch, ...props }) { return createElement('a', props); }");
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`, import.meta.url);

// next/image's dev-only remotePatterns check is skipped under NODE_ENV=test;
// without next.config it would reject every TMDB URL.
Object.assign(process.env, { NODE_ENV: "test" });
const { Poster } = await import("../src/components/poster");
const { TitleCard } = await import("../src/components/title-card");

function poster(props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    createElement(Poster, { path: "/abc.jpg", name: "The Long, Hot Summer", mediaType: "TV", ...props }),
  );
}

describe("Poster LCP hints (VE-09)", () => {
  it("preload sets high fetch priority and no lazy loading", () => {
    const html = poster({ lcp: "preload" });
    assert.match(html, /fetchPriority="high"/i);
    assert.doesNotMatch(html, /loading="lazy"/);
  });

  it("eager loads eagerly without preloading at high priority", () => {
    const html = poster({ lcp: "eager" });
    assert.match(html, /loading="eager"/);
    assert.doesNotMatch(html, /fetchPriority/i);
  });

  it("lazy-loads by default", () => {
    assert.match(poster(), /loading="lazy"/);
  });
});

describe("Poster placeholder (JK-29)", () => {
  it("shows the name only in containers at least 80px wide", () => {
    const html = poster({ path: null });
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /class="hidden [^"]*@min-\[80px\]:line-clamp-3">The Long, Hot Summer</);
  });
});

const item: CardItem = {
  id: "t1",
  name: "The Long, Hot Summer",
  mediaType: "TV",
  tmdbId: 1,
  posterPath: "/abc.jpg",
  year: 1965,
  tmdbRating: 6,
  status: "WATCHLIST",
  rating: null,
  favorite: false,
  totalEpisodes: 26,
  watchedEpisodes: 0,
};

function card(overrides: Partial<CardItem> = {}) {
  const router = { prefetch() {} } as unknown as AppRouterInstance;
  return renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: router },
      createElement(TitleCard, { item: { ...item, ...overrides } }),
    ),
  );
}

/** Text content of the element with this id (enough for these flat chips). */
function textOf(html: string, id: string): string | null {
  const open = new RegExp(`<(\\w+) id="${id}"[^>]*>`).exec(html);
  if (!open) return null;
  const tag = open[1];
  let depth = 1;
  const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, "g");
  re.lastIndex = open.index + open[0].length;
  let match: RegExpExecArray | null;
  while (depth > 0 && (match = re.exec(html))) depth += match[0].startsWith("</") ? -1 : 1;
  return html.slice(open.index + open[0].length, re.lastIndex).replace(/<[^>]+>/g, "");
}

/** The link's description as accname builds it: missing ids are skipped. */
function description(html: string): string {
  const ids = html.match(/<a [^>]*aria-describedby="([^"]+)"/)?.[1].split(" ") ?? [];
  return ids
    .map((id) => textOf(html, id))
    .filter((text) => text !== null)
    .join(" ");
}

describe("TitleCard link", () => {
  it("is named by its heading (JK-22)", () => {
    const html = card();
    const labelledby = html.match(/<a [^>]*aria-labelledby="([^"]+)"/)?.[1];
    assert.ok(labelledby);
    assert.match(html, new RegExp(`<h2 id="${labelledby}"[^>]*>The Long, Hot Summer</h2>`));
  });

  it("is described by the meta line, the status and the rating (JK-22)", () => {
    assert.equal(description(card()), "1965 · 0/26 eps Watchlist TMDB rating 6.0");
  });

  it("also describes favorite, new episodes and unmatched when shown", () => {
    assert.equal(
      description(card({ favorite: true, hasNewEpisodes: true, tmdbId: null })),
      "1965 · 0/26 eps Watchlist Favorite New Unmatched TMDB rating 6.0",
    );
  });

  it("has press feedback and no hover lift (EM-01, EM-09)", () => {
    const anchor = card().match(/<a [^>]*>/)?.[0] ?? "";
    assert.match(anchor, /motion-safe:active:scale-\[0\.98\]/);
    assert.doesNotMatch(anchor, /translate-y/);
  });
});

describe("TitleCard poster edge (JK-33)", () => {
  it("draws the outline on an overlay above the image, not under it", () => {
    const wrapper = card().match(/<div class="relative aspect-\[2\/3\][^"]*"/)?.[0] ?? "";
    assert.match(wrapper, /after:absolute after:inset-0 [^"]*after:outline after:-outline-offset-1 after:outline-white\/10/);
    assert.doesNotMatch(wrapper, /(^|\s)outline(\s|")/);
  });
});
