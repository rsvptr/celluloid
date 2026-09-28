import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { nextLazyDialogState, retryingLoader } from "../src/lib/retry-load";

async function source(path: string) {
  return readFile(new URL(`../src/${path}`, import.meta.url), "utf8");
}

/** A loader that fails `failures` times, then resolves "view". */
function flaky(failures: number) {
  let calls = 0;
  const load = async () => {
    calls++;
    if (calls <= failures) throw new Error(`ChunkLoadError ${calls}`);
    return "view";
  };
  return { load, calls: () => calls };
}

// P7U-1: a lazy dialog chunk that failed to load was thrown into render, where
// React.lazy cached the rejection and the route's error screen took the page.
describe("lazy dialog loading (P7U-1)", () => {
  it("retries a failed load once", async () => {
    const chunk = flaky(1);
    assert.equal(await retryingLoader(chunk.load)(), "view");
    assert.equal(chunk.calls(), 2);
  });

  it("rejects after the retry fails, then tries again on the next call", async () => {
    const chunk = flaky(2);
    const load = retryingLoader(chunk.load);
    await assert.rejects(load(), /ChunkLoadError 2/);
    assert.equal(chunk.calls(), 2);
    // The rejection isn't memoized: a later attempt reaches the network.
    assert.equal(await load(), "view");
    assert.equal(chunk.calls(), 3);
  });

  it("shares one load between callers and keeps a success", async () => {
    const chunk = flaky(0);
    const load = retryingLoader(chunk.load);
    assert.deepEqual(await Promise.all([load(), load()]), ["view", "view"]);
    assert.equal(await load(), "view");
    assert.equal(chunk.calls(), 1);
  });

  it("keeps the fallback while closed, and clears it once an open fallback closes", () => {
    // Failed at idle, closed: stays failed, so an offline page doesn't loop.
    assert.deepEqual(nextLazyDialogState({ failed: true, wasOpen: false }, false), {
      failed: true,
      wasOpen: false,
    });
    // Opened while failed: the fallback handles this open.
    assert.deepEqual(nextLazyDialogState({ failed: true, wasOpen: false }, true), {
      failed: true,
      wasOpen: true,
    });
    // The fallback closed: the next render tries the chunk again.
    assert.deepEqual(nextLazyDialogState({ failed: true, wasOpen: true }, false), {
      failed: false,
      wasOpen: false,
    });
    // A working dialog only tracks open.
    assert.deepEqual(nextLazyDialogState({ failed: false, wasOpen: false }, true), {
      failed: false,
      wasOpen: true,
    });
    assert.deepEqual(nextLazyDialogState({ failed: false, wasOpen: true }, false), {
      failed: false,
      wasOpen: false,
    });
  });

  it("renders the fallback from an error boundary around the lazy view", async () => {
    const boundary = await source("components/lazy-dialog.tsx");
    assert.match(boundary, /const loadView = retryingLoader\(load\);/);
    assert.match(boundary, /static getDerivedStateFromError\(\)[^{]*\{\s*return \{ failed: true \};/);
    assert.match(boundary, /return nextLazyDialogState\(state, props\.open\);/);
    assert.match(boundary, /componentDidCatch\(\) \{\s*View = lazyView\(\);\s*\}/);
    assert.match(boundary, /if \(this\.state\.failed\) return <Fallback \{\.\.\.this\.props\} \/>;/);
    assert.match(boundary, /<Suspense fallback=\{null\}>\s*<View \{\.\.\.this\.props\} \/>\s*<\/Suspense>/);
  });

  it("falls back to the browser's confirm so callers still settle", async () => {
    const confirm = await source("components/confirm-dialog.tsx");
    const fallback = confirm.slice(confirm.indexOf("function NativeConfirm("), confirm.indexOf("const ConfirmDialogView"));
    assert.match(
      fallback,
      /if \(open\) onSettle\(window\.confirm\(opts\.body \? `\$\{opts\.title\}\\n\\n\$\{opts\.body\}` : opts\.title\)\);/,
    );
  });

  it("tells the owner sharing couldn't open and closes, leaving the library usable", async () => {
    const library = await source("components/library.tsx");
    const fallback = library.slice(library.indexOf("function ShareUnavailable("), library.indexOf("const ShareDialog"));
    assert.match(fallback, /if \(!open\) return;\s*toast\.error\("Couldn't open sharing\. Try again\."\);\s*onClose\(\);/);
  });
});

// P7U-3: before the chunk loads nothing blocks a second click, and replacing
// the resolver left the first caller's promise pending forever.
describe("useConfirm called again before an answer (P7U-3)", () => {
  it("settles the pending confirm with false before taking the new one", async () => {
    const confirm = await source("components/confirm-dialog.tsx");
    const confirmFn = confirm.slice(confirm.indexOf("const confirm = useCallback("), confirm.indexOf("const settle = useCallback("));
    assert.match(
      confirmFn,
      /^const confirm = useCallback\(\(o: ConfirmOptions\) => \{\s*(?:\/\/.*\s*)*resolver\.current\(false\);\s*opener\.current =/,
    );
    assert.match(confirmFn, /resolver\.current = resolve;/);
    // settle() resets the resolver, so answering first makes this a no-op.
    const settle = confirm.slice(confirm.indexOf("const settle = useCallback("));
    assert.match(settle, /const r = resolver\.current;\s*resolver\.current = \(\) => \{\};\s*r\(v\);/);
  });
});
