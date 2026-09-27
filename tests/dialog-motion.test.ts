import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { describe, it } from "node:test";

const SRC = new URL("../src/", import.meta.url);

async function source(path: string) {
  return readFile(new URL(path, SRC), "utf8");
}

/** The body of the first `selector { … }` rule in `css`. */
function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no rule for ${selector}`);
  return css.slice(start, css.indexOf("}", start));
}

// EM-03: Radix's Presence waits for a closed-state animation, so dialogs can
// animate out. Exit 150 ms, enter 200 ms, both on emil's ease-out.
describe("dialog motion (EM-03)", () => {
  it("animates both states of the shared dialog classes", async () => {
    const css = await source("app/globals.css");
    assert.match(css, /--duration-dialog-in: 200ms;/);
    assert.match(css, /--duration-dialog-out: 150ms;/);
    const cases = [
      ["overlay", "open", "in"],
      ["overlay", "closed", "out"],
      ["content", "open", "in"],
      ["content", "closed", "out"],
    ];
    for (const [part, state, dir] of cases) {
      assert.match(
        rule(css, `.dialog-${part}[data-state="${state}"]`),
        new RegExp(`animation: dialog-${part}-${dir} var\\(--duration-dialog-${dir}\\) var\\(--ease-out\\);`),
      );
    }
    assert.match(css, /@keyframes dialog-content-out \{\s*to \{\s*opacity: 0;\s*scale: 0\.97;/);
  });

  it("gives every Radix dialog, import review included, the shared classes", async () => {
    const entries = await readdir(SRC, { recursive: true });
    let dialogs = 0;
    for (const file of entries.filter((entry) => entry.endsWith(".tsx"))) {
      const text = await source(file);
      const overlays = [...text.matchAll(/<(?:Alert)?Dialog\.Overlay className="([^"]*)"/g)];
      const contents = text.match(/<(?:Alert)?Dialog\.Content\b/g) ?? [];
      assert.equal(overlays.length, contents.length, file);
      for (const [, classes] of overlays) assert.match(classes, /^dialog-overlay /, file);
      assert.equal(text.match(/className="dialog-content /g)?.length ?? 0, contents.length, file);
      assert.doesNotMatch(text, /animate-\[dialog-/, `${file}: use the dialog-* classes`);
      dialogs += contents.length;
    }
    assert.equal(dialogs, 5);
  });

  it("keeps each dialog's content still while it fades out", async () => {
    const share = await source("components/share-dialog.tsx");
    const openChange = share.slice(share.indexOf("function handleOpenChange("), share.indexOf("function create("));
    assert.doesNotMatch(openChange, /reset\(\)/, "share-dialog resets only after the exit");
    assert.match(share, /onCloseAutoFocus=\{\(e\) => \{\s*reset\(\);/);

    const review = await source("components/import-review.tsx");
    assert.match(review, /<Dialog\.Root open=\{matchOpen\} onOpenChange=\{setMatchOpen\}>/);
    assert.doesNotMatch(review, /setMatchingItem\(null\)/);

    const match = await source("components/match-controls.tsx");
    const content = match.slice(match.indexOf("<Dialog.Content"), match.indexOf("</Dialog.Content>"));
    assert.doesNotMatch(content, /[{ (!]unmatched\b|\{name\}|\bpending\b/, "match dialog reads the held copy");
    assert.match(match, /setShown\(\(s\) => \(\{ \.\.\.s, saved: true \}\)\);\s*setOpen\(false\);/);
  });
});
