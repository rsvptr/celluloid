import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// A network error from authClient.deleteUser escaped the transition and
// reached the route error page.
describe("Delete account on a network error", () => {
  it("shows the inline error and stays on the page", async () => {
    const danger = await readFile(new URL("../src/app/(app)/settings/danger-section.tsx", import.meta.url), "utf8");
    const handler = danger.slice(danger.indexOf("start(async () => {"), danger.indexOf("router.refresh();"));
    const tryAt = handler.indexOf("try {");
    const call = handler.indexOf("await authClient.deleteUser({ password })");
    const catchAt = handler.indexOf("} catch {");
    const leave = handler.indexOf('router.push("/login")');
    assert.ok(tryAt !== -1 && tryAt < call && call < catchAt && catchAt < leave, "deleteUser runs inside try");
    assert.match(
      handler.slice(catchAt),
      /^\} catch \{\s*setError\("Celluloid couldn't delete your account\. Check your connection and retry\."\);\s*return;\s*\}/,
    );
    // The same Notice that shows the server's error shows this one.
    assert.match(danger, /\{error && <div className="mt-3"><Notice kind="error">\{error\}<\/Notice><\/div>\}/);
  });
});
