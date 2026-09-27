import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnimatePresence, PresenceContext } from "motion/react";
import { InertOnExit } from "../src/components/motion";

// children goes in createElement's third argument, which its typing doesn't see.
const props = { className: "min-h-0" } as ComponentProps<typeof InertOnExit>;
const fields = () => createElement(InertOnExit, props, "fields");

function inPresence(isPresent: boolean, child: ReactNode) {
  return createElement(
    PresenceContext.Provider,
    { value: { id: "panel", isPresent, register: () => () => {} } },
    child,
  );
}

describe("InertOnExit", () => {
  it("leaves an open panel interactive, on the server and outside AnimatePresence", () => {
    assert.equal(renderToStaticMarkup(fields()), '<div class="min-h-0">fields</div>');
    assert.equal(
      renderToStaticMarkup(createElement(AnimatePresence, null, fields())),
      '<div class="min-h-0">fields</div>',
    );
    assert.equal(renderToStaticMarkup(inPresence(true, fields())), '<div class="min-h-0">fields</div>');
  });

  it("makes the panel inert while its AnimatePresence child is exiting", () => {
    assert.equal(
      renderToStaticMarkup(inPresence(false, fields())),
      '<div class="min-h-0" inert="">fields</div>',
    );
  });
});

// The moving pill can't follow a route change without Motion's features, so a
// failed load (motion.tsx flags <html>) must hand the active link back to the
// static pill in CSS, whatever the pill state says.
describe("desktop nav pill without Motion's features", () => {
  it("swaps the moving pill for the active link's static pill under data-motion-failed", async () => {
    const nav = await readFile(new URL("../src/components/nav.tsx", import.meta.url), "utf8");
    const moving = nav.match(/<motion\.span\b[^>]*?className="([^"]*)"[^>]*?initial=\{false\}/);
    assert.ok(moving, "the moving pill should be a motion.span with initial={false}");
    assert.match(moving[1], /(^| )\[\[data-motion-failed\]_&\]:hidden( |$)/);
    assert.match(nav, /\{active && \(\s*<span\s+className=\{cn\(\s*"absolute inset-0 [^"]*",\s*pill && "hidden \[\[data-motion-failed\]_&\]:block",/);
    assert.doesNotMatch(nav, /layoutId=/);
  });
});
