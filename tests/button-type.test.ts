import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui";

async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) files.push(...(await sourceFiles(url)));
    else if (entry.name.endsWith(".tsx")) files.push(url);
  }
  return files;
}

/** Each `<form ...>...</form>` in a file (forms aren't nested in this app). */
function forms(file: string): string[] {
  // `<form` plus whitespace: a JSX element with attributes, not "<form>" in a
  // comment (every form here has at least onSubmit).
  return [...file.matchAll(/<form\s/g)].map(({ index }) =>
    file.slice(index, file.indexOf("</form>", index)),
  );
}

// A native <button> defaults to type="submit". Without a default on Button,
// wrapping a panel in <form> would turn Cancel (and every other Button) into a
// submit button (JK-11 verification).
describe("Button type (JK-11 prerequisite)", () => {
  it("renders type=button by default", () => {
    assert.match(renderToStaticMarkup(createElement(Button, null, "Cancel")), /^<button type="button"/);
  });

  it("lets callers pass type=submit", () => {
    assert.match(
      renderToStaticMarkup(createElement(Button, { type: "submit" }, "Save")),
      /^<button type="submit"/,
    );
  });

  it("every form submits through an explicit type=submit", async () => {
    const files = await sourceFiles(new URL("../src/", import.meta.url));
    let count = 0;
    for (const url of files) {
      for (const form of forms(await readFile(url, "utf8"))) {
        count++;
        assert.match(form, /type="submit"/, `form without a submit button in ${url.pathname}`);
      }
    }
    assert.ok(count > 0);
  });
});

// Before hydration (slow or failed JS) there is no onSubmit to preventDefault,
// and a form with no method submits natively as GET to the current URL, which
// puts every named field, passwords included, in the URL, history and server
// logs. POST keeps them out of the URL.
describe("forms submit natively as POST", () => {
  it("every <form> in src/ has method=post", async () => {
    const files = await sourceFiles(new URL("../src/", import.meta.url));
    let count = 0;
    for (const url of files) {
      // auth-form.tsx gets its method on a separate branch (merge conflict).
      if (url.pathname.endsWith("/src/app/login/auth-form.tsx")) continue;
      for (const form of forms(await readFile(url, "utf8"))) {
        count++;
        // The opening tag, stepping over the `=>` of inline handlers.
        const openTag = form.match(/^<form(?:=>|[^>])*>/)?.[0] ?? "";
        assert.match(openTag, /\smethod="post"/, `form without method="post" in ${url.pathname}`);
      }
    }
    assert.ok(count >= 12, `expected at least 12 forms, found ${count}`);
  });
});
