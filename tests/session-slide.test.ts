import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  SESSION_SLIDE_INTERVAL_MS,
  SESSION_SLIDE_KEY,
  claimSessionSlide,
} from "../src/lib/session-slide";

// The app shell's daily session slide: the once-a-day gate, and the component
// that asks Better Auth for the session row (tests/session-refresh.test.ts
// checks that this request slides the session).

const DAY_MS = 24 * 60 * 60 * 1000;

function memoryStorage(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[SESSION_SLIDE_KEY, initial]]);
  return {
    items,
    storage: () => ({
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    }),
  };
}

describe("session slide gate", () => {
  const now = Date.UTC(2026, 8, 27, 12);

  it("claims at most once per 24 hours, storing the claim first", () => {
    assert.equal(SESSION_SLIDE_INTERVAL_MS, DAY_MS);
    const { items, storage } = memoryStorage();
    assert.equal(claimSessionSlide(storage, now), true);
    assert.equal(items.get(SESSION_SLIDE_KEY), String(now));
    assert.equal(claimSessionSlide(storage, now), false);
    assert.equal(claimSessionSlide(storage, now + DAY_MS - 1), false);
    assert.equal(items.get(SESSION_SLIDE_KEY), String(now));
    assert.equal(claimSessionSlide(storage, now + DAY_MS), true);
    assert.equal(items.get(SESSION_SLIDE_KEY), String(now + DAY_MS));
  });

  it("treats an unreadable or future timestamp as due", () => {
    for (const stored of ["", "soon", "NaN", "Infinity", String(now + 1)]) {
      const { items, storage } = memoryStorage(stored);
      assert.equal(claimSessionSlide(storage, now), true, JSON.stringify(stored));
      assert.equal(items.get(SESSION_SLIDE_KEY), String(now));
    }
  });

  it("never claims without usable storage", () => {
    const boom = () => {
      throw new Error("SecurityError");
    };
    assert.equal(claimSessionSlide(boom, now), false);
    assert.equal(claimSessionSlide(() => ({ getItem: boom, setItem: () => {} }), now), false);
    assert.equal(claimSessionSlide(() => ({ getItem: () => null, setItem: boom }), now), false);
  });
});

describe("SessionSlide wiring", async () => {
  const [component, layout] = await Promise.all([
    readFile(new URL("../src/components/session-slide.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/(app)/layout.tsx", import.meta.url), "utf8"),
  ]);

  it("checks visibility, then the gate, then loads the client and bypasses the cookie cache", () => {
    assert.match(
      component,
      /if \(document\.visibilityState !== "visible"\) return;\s*if \(!claimSessionSlide\(\(\) => window\.localStorage, Date\.now\(\)\)\) return;\s*try \{[\s\S]*?const \{ authClient \} = await import\("@\/lib\/auth-client"\);\s*await authClient\.getSession\(\{ query: \{ disableCookieCache: true \} \}\);\s*\} catch \{/,
    );
    assert.doesNotMatch(component, /^import[^;]*["']@\/lib\/auth-client["']/m);
  });

  it("runs on mount and whenever the tab becomes visible, and cleans up", () => {
    assert.match(component, /onVisibilityChange\(\);\s*document\.addEventListener\("visibilitychange", onVisibilityChange\);/);
    assert.match(component, /return \(\) => document\.removeEventListener\("visibilitychange", onVisibilityChange\);/);
  });

  it("is mounted in the signed-in app shell", () => {
    assert.match(layout, /import \{ SessionSlide \} from "@\/components\/session-slide";/);
    assert.match(layout, /<SessionSlide \/>/);
  });
});
