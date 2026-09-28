import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function source(path: string) {
  return readFile(join(SRC, path), "utf8");
}

// Static `import … from` and `export … from`, not `import type` and not a
// dynamic import(), which the bundler splits into its own chunk.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;

function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (!base) return null;
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx", ""]) {
    if (existsSync(base + ext) && !(base + ext).endsWith("/")) return base + ext;
  }
  throw new Error(`can't resolve ${specifier} from ${from}`);
}

/** Every module an entry pulls into its first load, as local paths and package names. */
async function staticGraph(entry: string) {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = async (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = await readFile(file, "utf8");
    // A server action reaches the client as a reference, not as its code.
    if (/^\s*["']use server["']/.test(text)) return;
    for (const [, specifier] of text.matchAll(STATIC_IMPORT)) {
      const local = resolveLocal(file, specifier);
      if (local) await visit(local);
      else packages.add(specifier);
    }
  };
  await visit(join(SRC, entry));
  return { files: [...files].map((f) => f.slice(SRC.length)), packages: [...packages] };
}

// VE-11: the library is the most visited route, and its dialogs open only on a
// click, so Radix Dialog and AlertDialog load after the page does.
describe("lazy library dialogs (VE-11)", () => {
  it("keeps Radix out of the library's first load", async () => {
    const { files, packages } = await staticGraph("components/library.tsx");
    assert.ok(files.includes("components/confirm-dialog.tsx"), "the walk reaches useConfirm");
    assert.deepEqual(packages.filter((name) => name.startsWith("@radix-ui/")), []);
    assert.ok(!files.includes("components/share-dialog.tsx"));
    assert.ok(!files.includes("components/confirm-dialog-view.tsx"));
  });

  it("mounts the share dialog on idle or first open, then keeps it for its exit", async () => {
    const library = await source("components/library.tsx");
    assert.match(
      library,
      /const ShareDialog = lazyDialog\(\s*\(\) => import\("\.\/share-dialog"\)\.then\(\(m\) => m\.ShareDialog\),\s*ShareUnavailable,\s*\);/,
    );
    assert.match(library, /useEffect\(\(\) => whenIdle\(\(\) => setShareMounted\(true\)\), \[\]\);/);
    const openShare = library.slice(library.indexOf("function openShare("), library.indexOf("function surprise("));
    assert.match(openShare, /setShareMounted\(true\);\s*setShareOpen\(true\);/);
    // Closing only flips `open`; the dialog stays mounted and Radix plays the exit.
    assert.match(library, /\{shareMounted && \(\s*<ShareDialog\s+open=\{shareOpen\}/);
    assert.doesNotMatch(library, /setShareMounted\(false\)/);
    // Focus still returns to whatever opened it (JK-03).
    assert.match(library, /opener=\{shareOpener\}/);
  });

  it("mounts useConfirm's dialog the same way, keeping its promise API", async () => {
    const confirm = await source("components/confirm-dialog.tsx");
    assert.doesNotMatch(confirm, /from "@radix-ui\//);
    assert.match(
      confirm,
      /const ConfirmDialogView = lazyDialog\(\s*\(\) => import\("\.\/confirm-dialog-view"\)\.then\(\(m\) => m\.ConfirmDialogView\),\s*NativeConfirm,\s*\);/,
    );
    assert.match(confirm, /useEffect\(\(\) => whenIdle\(\(\) => setMounted\(true\)\), \[\]\);/);
    const confirmFn = confirm.slice(confirm.indexOf("const confirm = useCallback("), confirm.indexOf("const settle = useCallback("));
    assert.match(confirmFn, /setMounted\(true\);\s*setOpen\(true\);\s*return new Promise<boolean>/);
    assert.match(confirm, /const dialog = mounted \? \(\s*<ConfirmDialogView\s+open=\{open\}/);
    assert.doesNotMatch(confirm, /setMounted\(false\)/);

    const view = await source("components/confirm-dialog-view.tsx");
    assert.match(view, /<AlertDialog\.Content\s+onCloseAutoFocus=\{onCloseAutoFocus\}/);
    assert.match(view, /onClick=\{\(\) => onSettle\(true\)\}/);
    assert.match(view, /if \(!o\) onSettle\(false\);/);
  });
});
