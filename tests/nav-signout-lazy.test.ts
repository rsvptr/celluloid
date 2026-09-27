import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// VE-11: the better-auth client is only used to sign out, so the app shell's
// nav loads it on demand instead of shipping it on every signed-in page.
describe("nav sign-out (VE-11)", async () => {
  const nav = await readFile(new URL("../src/components/nav.tsx", import.meta.url), "utf8");

  it("has no static import of the auth client", () => {
    assert.doesNotMatch(nav, /^import[^;]*["']@\/lib\/auth-client["']/m);
  });

  it("imports it inside the guarded try before signing out", () => {
    const start = nav.indexOf("async function handleSignOut()");
    assert.notEqual(start, -1);
    const handler = nav.slice(start, nav.indexOf("\n  }\n", start));
    assert.match(
      handler,
      /signingOutRef\.current = true;\s*try \{[\s\S]*const \{ authClient \} = await import\("@\/lib\/auth-client"\);\s*await authClient\.signOut\(\);\s*router\.push\("\/login"\);/,
    );
    assert.match(handler, /catch \{\s*toast\.error\(/);
  });
});
