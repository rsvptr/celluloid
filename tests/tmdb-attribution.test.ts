import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("TMDB attribution (TM-01)", () => {
  it("shows the approved logo, linked to TMDB, with the exact required notice", async () => {
    const [component, logo] = await Promise.all([
      source("../src/components/tmdb-attribution.tsx"),
      source("../public/tmdb-logo.svg"),
    ]);
    assert.ok(
      component.includes(
        "This product uses the TMDB API but is not endorsed or certified by TMDB.",
      ),
    );
    assert.match(component, /href="https:\/\/www\.themoviedb\.org"/);
    assert.match(component, /src="\/tmdb-logo\.svg"/);
    // Sized by height only, so the logo keeps its own aspect ratio.
    assert.match(component, /className="h-3 w-auto"/);
    assert.match(logo, /^<svg[\s\S]*<\/svg>\s*$/);
  });

  it("renders on the public share page and in the settings About section", async () => {
    const [share, settings] = await Promise.all([
      source("../src/app/s/[slug]/page.tsx"),
      source("../src/app/(app)/settings/settings-client.tsx"),
    ]);
    const footer = share.slice(share.indexOf("<footer"), share.indexOf("</footer>"));
    assert.match(footer, /<TmdbAttribution\b/);

    const about = settings.slice(settings.indexOf("function AboutSection"));
    assert.match(about, /title="About"/);
    assert.match(about, /<TmdbAttribution \/>/);
    assert.match(about, /JustWatch/);
    assert.match(settings, /<AboutSection \/>/);
  });

  it("labels the provider link by where it goes: TMDB, not JustWatch (TM-09)", async () => {
    const extras = await source("../src/app/(app)/title/[id]/title-extras.tsx");
    const links = [...extras.matchAll(/<a\s[^>]*href=\{watch\.link\}[^>]*>\s*([^<{]+)/g)].map(
      (match) => match[1].trim(),
    );
    assert.deepEqual(links, ["Check TMDB", "Open on TMDB"]);
    assert.doesNotMatch(extras, /Check JustWatch/);
    // The data is still JustWatch's, and TMDB's terms ask for that attribution.
    assert.match(extras, /Streaming availability via JustWatch/);
  });

  it("keeps the logo out of the auth gate so anonymous share visitors can load it", async () => {
    const proxy = await source("../src/proxy.ts");
    const matcher = proxy.match(/matcher:\s*\[\s*"([^"]+)"/)?.[1];
    assert.ok(matcher, "proxy matcher not found");
    const gated = new RegExp(`^${matcher}$`);
    assert.equal(gated.test("/tmdb-logo.svg"), false);
    assert.equal(gated.test("/logo.png"), false);
    assert.equal(gated.test("/s/abc123"), true);
    assert.equal(gated.test("/settings"), true);
  });
});
