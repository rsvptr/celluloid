import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { register } from "node:module";
import { describe, it } from "node:test";

const origin = "http://localhost:3000";
const jar = new Map<string, string>();

function absorb(response: Response) {
  for (const raw of response.headers.getSetCookie()) {
    const [pair, ...attributes] = raw.split(";");
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1);
    const expired = attributes.some((attribute) => /max-age=0/i.test(attribute.trim()));
    if (expired || value === "") jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function requestHeaders() {
  return new Headers({
    cookie: cookieHeader(),
    origin,
    "next-action": "test-update-profile",
  });
}

Object.assign(globalThis, {
  __CELLULOID_AUTH_ENV__: {
    BETTER_AUTH_URL: origin,
    NEXT_PUBLIC_SITE_URL: origin,
    BETTER_AUTH_SECRET: "isolated-auth-test-secret-12345678901234567890",
    SIGNUP_INVITE_CODE: "test-invite",
  },
  __CELLULOID_AUTH_PRISMA__: {},
  __CELLULOID_AUTH_INSTANCE__: null,
  __CELLULOID_AUTH_HEADERS__: async () => requestHeaders(),
  __CELLULOID_AUTH_COOKIES__: async () => ({
    set(name: string, value: string, options?: { maxAge?: number }) {
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
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return stub("export async function requireUserId() { return 'user-1'; }");
  }
  if (specifier === "@/lib/crypto" || normalized.endsWith("/src/lib/crypto")) {
    return stub("export function encryptSecret(value) { return value; }");
  }
  if (specifier === "@/lib/models" || normalized.endsWith("/src/lib/models")) {
    return stub("export function isRecModel() { return true; }");
  }
  if (specifier === "@/lib/region-actions" || normalized.endsWith("/src/lib/region-actions")) {
    return stub("export async function setWatchRegion() {}");
  }
  if (specifier === "@/lib/tmdb-extras" || normalized.endsWith("/src/lib/tmdb-extras")) {
    return stub("export function isWatchRegion() { return true; }");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath() {}");
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
const { updateProfile } = await import("../src/lib/settings-actions");

async function call(path: string, body?: unknown, method = "POST") {
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader(),
        origin,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  absorb(response);
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return {
    status: response.status,
    json,
  };
}

describe("Celluloid auth write boundaries", { concurrency: false }, () => {
  it("disables public profile writes, refreshes rename cookies, and requires delete password", async () => {
    const password = "synthetic-password-12345";
    const signup = await call("/sign-up/email", {
      inviteCode: "test-invite",
      name: "Original Name",
      email: "auth-boundary@example.test",
      password,
    });
    assert.equal(signup.status, 200);
    assert.ok(jar.has("better-auth.session_token"));
    assert.ok(jar.has("better-auth.session_data"));

    const publicUpdate = await call("/update-user", { name: "x".repeat(81) });
    assert.equal(publicUpdate.status, 404);

    assert.deepEqual(await updateProfile("n".repeat(1_000)), { ok: true });
    const renamed = await call("/get-session", undefined, "GET");
    assert.equal(renamed.status, 200);
    assert.equal(
      (renamed.json as { user: { name: string } }).user.name,
      "n".repeat(80),
    );

    const missing = await call("/delete-user", {});
    assert.equal(missing.status, 400);
    assert.match(
      (missing.json as { message: string }).message,
      /current password/i,
    );

    const wrong = await call("/delete-user", { password: "wrong-password" });
    assert.equal(wrong.status, 400);
    const stillSignedIn = await call("/get-session", undefined, "GET");
    assert.ok((stillSignedIn.json as { user?: unknown } | null)?.user);

    const correct = await call("/delete-user", { password });
    assert.equal(correct.status, 200);
    assert.equal((correct.json as { success: boolean }).success, true);
  });
});

/** POSTs from a given client IP. The limiter keys on IP and path and runs
 * before routing, so a signed-out request spends the same budget. */
async function statusFrom(ip: string, path: string) {
  const response = await auth.handler(
    new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, "x-forwarded-for": ip },
      body: "{}",
    }),
  );
  await response.body?.cancel();
  return response.status;
}

describe("auth rate limits", { concurrency: false }, () => {
  it("caps every endpoint that checks a password or a 2FA code (BA-02)", async () => {
    const budgets: Array<[path: string, max: number]> = [
      ["/sign-in/email", 10],
      ["/change-password", 5],
      ["/verify-password", 5],
      ["/delete-user", 5],
      ["/two-factor/enable", 5],
      ["/two-factor/disable", 5],
      ["/two-factor/generate-backup-codes", 5],
      ["/two-factor/get-totp-uri", 5],
      ["/two-factor/verify-totp", 10],
      ["/two-factor/verify-backup-code", 5],
      ["/two-factor/verify-otp", 5],
    ];
    for (const [index, [path, max]] of budgets.entries()) {
      const ip = `203.0.113.${index + 1}`;
      for (let attempt = 1; attempt <= max; attempt++) {
        assert.notEqual(await statusFrom(ip, path), 429, `${path} attempt ${attempt}`);
      }
      assert.equal(await statusFrom(ip, path), 429, `${path} attempt ${max + 1}`);
    }
  });

  it("keeps /get-session out of the limiter entirely (BA-01)", async () => {
    const ip = "198.51.100.7";
    // One past the global 100-per-minute budget.
    for (let request = 1; request <= 101; request++) {
      const response = await auth.handler(
        new Request(`${origin}/api/auth/get-session`, {
          headers: { origin, "x-forwarded-for": ip },
        }),
      );
      await response.body?.cancel();
      assert.equal(response.status, 200, `request ${request}`);
    }
    // No counter row either: the rule skips the limiter's database writes, not
    // just its verdict.
    const { adapter } = await auth.$context;
    const rows = await adapter.findMany({
      model: "rateLimit",
      where: [{ field: "key", value: `${ip}|/get-session` }],
    });
    assert.deepEqual(rows, []);
  });
});

/** A browser with its own cookie jar, calling the auth API from `ip`. */
function device(ip: string) {
  const cookies = new Map<string, string>();
  return async (path: string, body?: unknown, method = "POST") => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
          cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1);
      if (value === "" || attributes.some((a) => /max-age=0/i.test(a.trim()))) cookies.delete(name);
      else cookies.set(name, value);
    }
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as unknown };
  };
}

/** The current 6-digit code for an otpauth:// URI (RFC 6238, SHA-1, 30 s). */
function totpCode(uri: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...(new URL(uri).searchParams.get("secret") ?? "")]
    .map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0"))
    .join("");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

describe("two-factor account changes", { concurrency: false }, () => {
  const password = "synthetic-password-67890";
  const email = "two-factor-sessions@example.test";
  const laptop = device("192.0.2.10");
  let setupCodes: string[] = [];

  it("turning 2FA on and then revoking other sessions keeps only this device (BA-07)", async () => {
    const stolen = device("192.0.2.66");
    assert.equal(
      (await laptop("/sign-up/email", { inviteCode: "test-invite", name: "Owner", email, password }))
        .status,
      200,
    );
    assert.equal((await stolen("/sign-in/email", { email, password })).status, 200);

    // The Settings flow: enable with the password, verify a code, then revoke.
    const enabled = await laptop("/two-factor/enable", { password });
    assert.equal(enabled.status, 200);
    const { totpURI, backupCodes } = enabled.json as { totpURI: string; backupCodes: string[] };
    setupCodes = backupCodes;
    assert.equal((await laptop("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    assert.equal((await laptop("/revoke-other-sessions", {})).status, 200);

    const current = await laptop("/get-session?disableCookieCache=true", undefined, "GET");
    const { user, session } = current.json as {
      user: { id: string; twoFactorEnabled: boolean };
      session: { token: string };
    };
    assert.equal(user.twoFactorEnabled, true);
    const { internalAdapter } = await auth.$context;
    const remaining = await internalAdapter.listSessions(user.id);
    assert.deepEqual(
      remaining.map((row) => row.token),
      [session.token],
      "only the session verifyTotp issued to this device survives",
    );
    const other = await stolen("/get-session?disableCookieCache=true", undefined, "GET");
    assert.equal(other.json, null);
  });

  it("regenerating backup codes needs the password and retires the old codes (BA-09)", async () => {
    assert.equal(setupCodes.length, 10);
    const wrong = await laptop("/two-factor/generate-backup-codes", { password: "not-my-password" });
    assert.equal(wrong.status, 400);

    // The shape Settings reads: { backupCodes } in Better Auth's xxxxx-xxxxx form.
    const fresh = await laptop("/two-factor/generate-backup-codes", { password });
    assert.equal(fresh.status, 200);
    const { backupCodes } = fresh.json as { backupCodes: string[] };
    assert.equal(backupCodes.length, 10);
    for (const code of backupCodes) assert.match(code, /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);

    // Settings tells the owner the old codes stop working; hold it to that.
    const old = await laptop("/two-factor/verify-backup-code", { code: setupCodes[0] });
    assert.equal(old.status, 401);
    const current = await laptop("/two-factor/verify-backup-code", { code: backupCodes[0] });
    assert.equal(current.status, 200);
  });
});
