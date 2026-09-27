import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("mobile More popover (JK-25)", () => {
  it("has no aria-label on its role-less panel", async () => {
    const nav = await source("../src/components/nav.tsx");
    const panel = nav.slice(nav.indexOf('id="nav-more-menu"'), nav.indexOf("<Link", nav.indexOf('id="nav-more-menu"')));
    assert.doesNotMatch(panel, /aria-label=/);
  });

  it("closes when focus moves outside the trigger and the panel", async () => {
    const nav = await source("../src/components/nav.tsx");
    assert.match(
      nav,
      /function onFocusIn\(e: FocusEvent\) \{\s*const target = e\.target as Node;\s*if \(\s*!morePopoverRef\.current\?\.contains\(target\) &&\s*!moreTriggerRef\.current\?\.contains\(target\)\s*\) \{\s*setMoreOpen\(false\);/,
    );
    assert.match(nav, /document\.addEventListener\("focusin", onFocusIn\);/);
    assert.match(nav, /document\.removeEventListener\("focusin", onFocusIn\);/);
  });
});

describe("header display name (JK-30)", () => {
  it("is capped and truncated, with the full name in title", async () => {
    const nav = await source("../src/components/nav.tsx");
    assert.match(nav, /className="hidden max-w-40 truncate text-sm text-muted lg:inline" title=\{userName\}/);
  });
});
