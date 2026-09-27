import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, SRC), "utf8");
}

// The smaller emil-design-eng items (EM-10 to EM-17) and the review nits.
describe("motion polish", () => {
  it("closes the More popover faster than it opens (EM-10)", async () => {
    const nav = await source("components/nav.tsx");
    const popover = nav.slice(nav.indexOf('id="nav-more-menu"'), nav.indexOf("className=", nav.indexOf('id="nav-more-menu"')));
    assert.match(popover, /exit=\{\{[^}]*transition: \{ duration: 0\.1, ease: EASE_OUT \},\s*\}\}/);
    assert.match(popover, /\}\}\s*transition=\{\{ duration: 0\.15, ease: EASE_OUT \}\}/);
  });

  it("measures the nav pill to the sub-pixel, like the static pill", async () => {
    const nav = await source("components/nav.tsx");
    const measure = nav.slice(nav.indexOf("const measure = () =>"), nav.indexOf("measure();"));
    assert.doesNotMatch(measure, /link\.offset/);
    assert.match(measure, /x: box\.left - nav\.getBoundingClientRect\(\)\.left, width: box\.width/);
  });

  it("docks the bulk bar from its full height on the drawer curve, leaving faster (EM-11)", async () => {
    const library = await source("components/library.tsx");
    const bar = library.slice(library.indexOf("ref={barRef}"), library.indexOf(">", library.indexOf("exit=", library.indexOf("ref={barRef}"))));
    assert.match(bar, /initial=\{\{ y: "100%", opacity: 0 \}\}/);
    assert.match(bar, /animate=\{\{ y: 0, opacity: 1, transition: \{ duration: 0\.25, ease: EASE_DRAWER \} \}\}/);
    assert.match(bar, /exit=\{\{ y: "100%", opacity: 0, transition: \{ duration: 0\.2, ease: EASE_DRAWER \} \}\}/);
  });

  it("dismisses recommend cards without an exit-then-reflow, measuring on list changes only (EM-12, MO-06)", async () => {
    const rec = await source("app/(app)/recommend/recommend-client.tsx");
    const at = rec.indexOf('<AnimatePresence initial={false} mode="popLayout">');
    assert.notEqual(at, -1, "recommend cards need popLayout");
    // popLayout positions the exiting card against its nearest positioned parent.
    assert.match(rec.slice(rec.lastIndexOf("<div", at), at), /className="relative grid /);
    const card = rec.slice(at, rec.indexOf("<RecCard", at));
    assert.match(card, /layout="position"\s+layoutDependency=\{recs\}/);
    assert.match(card, /exit=\{\{ opacity: 0, scale: 0\.97, transition: \{ duration: 0\.15, ease: EASE_OUT \} \}\}/);
    assert.match(card, /layout: \{ type: "spring", visualDuration: 0\.3, bounce: 0 \}/);
  });

  it("keeps the login glow still (EM-13)", async () => {
    const [page, css] = await Promise.all([source("app/login/page.tsx"), source("app/globals.css")]);
    const glow = page.slice(page.lastIndexOf("<div", page.indexOf("blur-[120px]")), page.indexOf("/>", page.indexOf("blur-[120px]")));
    assert.doesNotMatch(glow, /hero-float|animate-/);
    assert.doesNotMatch(css, /hero-float/);
  });

  it("reveals the sign-up note with the name fields (MO-08)", async () => {
    const form = await source("app/login/auth-form.tsx");
    const reveal = /initial=\{false\}\s*animate=\{\{ opacity: 1, height: "auto" \}\}\s*exit=\{\{ opacity: 0, height: 0 \}\}\s*transition=\{\{ duration: 0\.22, ease: EASE_OUT \}\}/;
    const at = form.indexOf('key="signup-note"');
    assert.notEqual(at, -1, "the note needs its own presence child");
    const note = form.slice(at, form.indexOf("After you join", at));
    assert.match(note, reveal);
    assert.match(note, /className="-mt-4 grid grid-rows-\[1fr\] overflow-hidden motion-safe:animate-\[collapse-in_220ms_var\(--ease-out\)\]"/);
    assert.match(note, /<div className="min-h-0">\s*<p className="pt-4 /);
    // Same reveal as the name fields.
    const name = form.slice(form.indexOf('key="name"'), form.indexOf("<InertOnExit", form.indexOf('key="name"')));
    assert.match(name, reveal);
    assert.match(name, /motion-safe:animate-\[collapse-in_220ms_var\(--ease-out\)\]/);
  });
});
