import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

const origin = "http://localhost:3000";
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRES_IN_S = 30 * 24 * 60 * 60; // src/lib/auth.ts session.expiresIn

const jar = new Map<string, string>();
// Next lets route handlers and server actions set cookies; during a server
// component render, cookies().set throws, and Better Auth's nextCookies plugin
// swallows the error. `phase` picks which of the two the stub behaves like.
let phase: "render" | "action" = "action";
let cookieWrites: Array<{ name: string; maxAge?: number; dropped: boolean }> = [];

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

Object.assign(globalThis, {
  __CELLULOID_AUTH_ENV__: {
    BETTER_AUTH_URL: origin,
    NEXT_PUBLIC_SITE_URL: origin,
    BETTER_AUTH_SECRET: "isolated-session-test-secret-1234567890123456",
    SIGNUP_INVITE_CODE: "test-invite",
  },
  __CELLULOID_AUTH_PRISMA__: {},
  __CELLULOID_AUTH_INSTANCE__: null,
  __CELLULOID_AUTH_HEADERS__: async () => new Headers({ cookie: cookieHeader(), origin }),
  __CELLULOID_AUTH_COOKIES__: async () => ({
    set(name: string, value: string, options?: { maxAge?: number }) {
      cookieWrites.push({ name, maxAge: options?.maxAge, dropped: phase === "render" });
      if (phase === "render") {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      }
      if (value === "" || options?.maxAge === 0) jar.delete(name);
      else jar.set(name, value);
    },
  }),
});

const loader = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only") {
    return nextResolve(specifier, {
      ...context,
      conditions: [...context.conditions, "react-server"],
    });
  }
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const stub = (source) => ({
    url: "data:text/javascript," + encodeURIComponent(source),
    shortCircuit: true,
  });
  if (specifier === "@/lib/env" || normalized.endsWith("/src/lib/env")) {
    return stub("export const env = globalThis.__CELLULOID_AUTH_ENV__;");
  }
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_AUTH_PRISMA__;");
  }
  if (specifier === "@/lib/signup-invite" || normalized.endsWith("/src/lib/signup-invite")) {
    return stub("export function consumeSignupInvite(body, expected) {" +
      "if (!body || body.inviteCode !== expected) return false;" +
      "delete body.inviteCode; return true; }");
  }
  if (specifier === "better-auth/adapters/prisma") {
    return stub("export function prismaAdapter() { return undefined; }");
  }
  if (specifier === "@/lib/auth") {
    return stub("export const auth = globalThis.__CELLULOID_AUTH_INSTANCE__;");
  }
  if (specifier === "next/navigation") {
    return stub("export function redirect(url) { throw new Error('NEXT_REDIRECT ' + url); }");
  }
  if (specifier === "next/headers" || specifier === "next/headers.js") {
    return stub("export const headers = globalThis.__CELLULOID_AUTH_HEADERS__;" +
      "export const cookies = globalThis.__CELLULOID_AUTH_COOKIES__;");
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { auth } = await import("../src/lib/auth");
Object.assign(globalThis, { __CELLULOID_AUTH_INSTANCE__: auth });
const { getOptionalUser, getSession, requireUser, requireUserId } = await import(
  "../src/lib/session"
);
const { internalAdapter } = await auth.$context;

// Sign up through the HTTP handler, like the browser does, to get real cookies.
const signup = await auth.handler(
  new Request(`${origin}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({
      inviteCode: "test-invite",
      name: "Session Owner",
      email: "session-refresh@example.test",
      password: "synthetic-password-12345",
    }),
  }),
);
assert.equal(signup.status, 200);
for (const raw of signup.headers.getSetCookie()) {
  const [pair] = raw.split(";");
  const separator = pair.indexOf("=");
  jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1));
}
const { token } = (await signup.json()) as { token: string };

/**
 * Puts the session two days into its 30, past the daily `updateAge`, so the
 * next refreshing read slides it. Also drops the 60-second cookie cache, which
 * would otherwise answer without reaching the refresh logic.
 */
async function staleSession(): Promise<number> {
  const expiresAt = new Date(Date.now() + 28 * DAY_MS);
  await internalAdapter.updateSession(token, { expiresAt });
  jar.delete("better-auth.session_data");
  cookieWrites = [];
  return expiresAt.getTime();
}

async function storedExpiry(): Promise<number> {
  const found = await internalAdapter.findSession(token);
  assert.ok(found, "session row missing");
  return new Date(found.session.expiresAt).getTime();
}

/** The row now runs about 30 days from now, and the cookie was re-issued to match. */
async function assertSlid(before: number, label: string) {
  assert.ok((await storedExpiry()) > before + DAY_MS, `${label}: row not extended`);
  const write = cookieWrites.find((w) => w.name === "better-auth.session_token");
  assert.ok(write, `${label}: session cookie not re-issued`);
  assert.equal(write.dropped, false, `${label}: session cookie write dropped`);
  assert.equal(write.maxAge, EXPIRES_IN_S, `${label}: cookie Max-Age`);
}

describe("session refresh happens only where cookies can be written (BA-03)", { concurrency: false }, () => {
  it("page renders read the session without extending the row or writing cookies", async () => {
    phase = "render";
    const before = await staleSession();

    assert.equal((await requireUser()).email, "session-refresh@example.test");
    assert.equal((await getOptionalUser())?.email, "session-refresh@example.test");

    assert.equal(await storedExpiry(), before);
    assert.deepEqual(cookieWrites, []);
  });

  it("server actions (requireUserId) slide the row and the cookie together", async () => {
    phase = "action";
    const before = await staleSession();
    assert.equal(typeof (await requireUserId()), "string");
    await assertSlid(before, "requireUserId");
  });

  it("route handlers (getSession) slide the row and the cookie together", async () => {
    phase = "action";
    const before = await staleSession();
    assert.ok((await getSession())?.user);
    await assertSlid(before, "getSession");
  });

  it("a day that starts with a page load still slides on the first action", async () => {
    // Before the fix, the render extended the row and lost the cookie, and the
    // extended row then kept the action from refreshing at all.
    phase = "render";
    const before = await staleSession();
    await requireUser();

    phase = "action";
    cookieWrites = [];
    await requireUserId();
    await assertSlid(before, "action after render");
  });
});
