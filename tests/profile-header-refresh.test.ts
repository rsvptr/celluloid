import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

// The header shows the name from Better Auth's session_data cookie cache, read
// via getSession({ headers: await headers() }). updateProfile's updateUser call
// rewrites that cookie, but the page Next renders into the action's response
// syncs only cookies(), not headers(), so the header kept the old name until a
// reload. ProfileSection refreshes after saving for that reason (VE-02 had
// dropped the refresh as redundant).
const require = createRequire(import.meta.url);
const { createRequestStoreForAPI, synchronizeMutableCookies } = require(
  "next/dist/server/async-storage/request-store.js",
);

describe("profile save refreshes the header name", () => {
  it("Next's post-action render still sees the request's old Cookie header", () => {
    const cookie = "better-auth.session_data=old";
    const store = createRequestStoreForAPI(
      { headers: { cookie } },
      new URL("http://localhost/settings"),
      undefined,
      () => {},
      undefined,
      undefined,
    );
    store.mutableCookies.set("better-auth.session_data", "new");
    synchronizeMutableCookies(store); // what the action handler does before rendering

    assert.equal(store.cookies.get("better-auth.session_data")?.value, "new");
    // If a Next upgrade makes this "new", the refresh below can go again.
    assert.equal(store.headers.get("cookie"), cookie);
  });

  it("ProfileSection calls router.refresh() after a successful save", async () => {
    const src = await readFile(
      new URL("../src/app/(app)/settings/profile-section.tsx", import.meta.url),
      "utf8",
    );
    const start = src.indexOf("function ProfileSection(");
    assert.notEqual(start, -1);
    const section = src.slice(start, src.indexOf("\n}\n", start));
    assert.match(section, /const router = useRouter\(\);/);
    assert.match(
      section,
      /await updateProfile\(value\);[\s\S]*\} else \{[\s\S]*router\.refresh\(\);[\s\S]*\} catch \{/,
    );
  });
});
