import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { after, before, describe, it } from "node:test";

// Better Auth on in-memory Postgres (PGlite) with the repo's migrations, the
// generated Prisma client and Better Auth's own Prisma adapter. With a database
// Better Auth runs stateful, as in production: a compact 60-second cookie cache
// with no refresh, and a DB read on its sensitive endpoints. The other auth
// tests run it DB-less, where the cookie is the whole session and none of this
// shows. PGlite comes with prisma (through @prisma/dev), and the socket server
// lets the production pg driver adapter talk to it.

// A clock the test can move forward past the cookie cache. It keeps running in
// real time otherwise, so pg and Prisma timeouts behave. Installed before
// anything that reads the time is loaded.
const RealDate = Date;
let offsetMs = 0;
class ShiftedDate extends RealDate {
  constructor(...args: unknown[]) {
    // @ts-expect-error -- forwards any of Date's constructor overloads unchanged
    super(...(args.length ? args : [RealDate.now() + offsetMs]));
  }
  static now() {
    return RealDate.now() + offsetMs;
  }
}
globalThis.Date = ShiftedDate as DateConstructor;
function advance(seconds: number) {
  offsetMs += seconds * 1000;
}

const origin = "http://localhost:3000";
const secret = "isolated-auth-db-test-secret-1234567890123456";
process.env.BETTER_AUTH_SECRET = secret; // crypto.ts encrypts the API key with it

/**
 * A browser's cookies. A hostile jar is a script replaying stolen cookies: it
 * ignores deletions and Max-Age, and keeps anything new it's sent, so only the
 * server's own checks can end its session.
 */
class Jar {
  cookies = new Map<string, { value: string; expiresAt: number | null }>();
  /** Cookie writes from server actions and route handlers (next/headers). */
  writes: Array<{ name: string; value: string }> = [];
  constructor(readonly hostile = false) {}

  set(name: string, value: string, maxAge: number | undefined) {
    const cleared = value === "" || maxAge === 0;
    if (this.hostile) {
      if (!cleared) this.cookies.set(name, { value, expiresAt: null });
    } else if (cleared) {
      this.cookies.delete(name);
    } else {
      this.cookies.set(name, {
        value,
        expiresAt: maxAge === undefined ? null : Date.now() + maxAge * 1000,
      });
    }
  }

  header() {
    return [...this.cookies]
      .filter(([, { expiresAt }]) => expiresAt === null || expiresAt > Date.now())
      .map(([name, { value }]) => `${name}=${value}`)
      .join("; ");
  }

  absorb(response: Response) {
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const separator = pair.indexOf("=");
      const maxAge = attributes.map((a) => a.trim()).find((a) => /^max-age=/i.test(a));
      this.set(
        pair.slice(0, separator).trim(),
        pair.slice(separator + 1),
        maxAge ? Number(maxAge.split("=")[1]) : undefined,
      );
    }
  }
}

// next/headers answers for whichever request `as()` is running. During a
// render, cookies().set throws, as in Next (Better Auth's nextCookies swallows it).
let current: { jar: Jar; phase: "action" | "render" } = { jar: new Jar(), phase: "action" };
async function as<T>(jar: Jar, phase: "action" | "render", run: () => Promise<T>): Promise<T> {
  const previous = current;
  current = { jar, phase };
  try {
    return await run();
  } finally {
    current = previous;
  }
}

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

const db = await PGlite.create();
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter((entry) => /^\d/.test(entry)).sort()) {
  await db.exec(readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"));
}
// One connection: PGlite runs one session at a time.
const server = new PGLiteSocketServer({ db, port: 0 });
await server.start();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
    max: 1,
  }),
});

Object.assign(globalThis, {
  __CELLULOID_AUTH_DB_ENV__: {
    BETTER_AUTH_URL: origin,
    NEXT_PUBLIC_SITE_URL: origin,
    BETTER_AUTH_SECRET: secret,
    SIGNUP_INVITE_CODE: "test-invite",
  },
  __CELLULOID_AUTH_DB_PRISMA__: prisma,
  __CELLULOID_AUTH_DB_HEADERS__: async () =>
    new Headers({ cookie: current.jar.header(), origin }),
  __CELLULOID_AUTH_DB_COOKIES__: async () => ({
    set(name: string, value: string, options?: { maxAge?: number }) {
      current.jar.writes.push({ name, value });
      if (current.phase === "render") {
        throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      }
      current.jar.set(name, value, options?.maxAge);
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
    return stub("export const env = globalThis.__CELLULOID_AUTH_DB_ENV__;");
  }
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_AUTH_DB_PRISMA__;");
  }
  if (specifier === "next/cache") {
    return stub("export function revalidatePath() {}");
  }
  if (specifier === "next/navigation") {
    return stub("export function redirect(url) { throw new Error('NEXT_REDIRECT ' + url); }");
  }
  if (specifier === "next/headers" || specifier === "next/headers.js") {
    return stub("export const headers = globalThis.__CELLULOID_AUTH_DB_HEADERS__;" +
      "export const cookies = globalThis.__CELLULOID_AUTH_DB_COOKIES__;");
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { auth } = await import("../src/lib/auth");
const { getOptionalUser, getSession, requireUser, requireUserId } = await import(
  "../src/lib/session"
);
const { removeAnthropicKey, setAnthropicKey, updateProfile } = await import(
  "../src/lib/settings-actions"
);
const backupRoute = await import("../src/app/api/backup/route");
const restoreRoute = await import("../src/app/api/backup/restore/route");

/** A device: its cookie jar and client IP, calling the auth HTTP handler. */
function device(ip: string, jar = new Jar()) {
  const call = async (path: string, body?: unknown, method = "POST") => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
          cookie: jar.header(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    jar.absorb(response);
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : null) as unknown };
  };
  return Object.assign(call, { jar });
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

const signedOut = /signed out/;
const password = "synthetic-password-97531";
const email = "auth-db@example.test";
const laptop = device("192.0.2.10");
// The thief signed in with the password too, so only the session check stands
// between it and each action.
const thief = device("192.0.2.66", new Jar(true));
let userId = "";

async function sessionTokens() {
  const rows = await prisma.session.findMany({ where: { userId }, select: { token: true } });
  return rows.map((row) => row.token);
}

before(async () => {
  const signup = await laptop("/sign-up/email", {
    inviteCode: "test-invite",
    name: "Owner",
    email,
    password,
  });
  assert.equal(signup.status, 200);
  userId = (signup.json as { user: { id: string } }).user.id;
  assert.equal((await thief("/sign-in/email", { email, password })).status, 200);
  assert.equal((await sessionTokens()).length, 2);
});

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

describe("sessions against Postgres", { concurrency: false }, () => {
  it("runs Better Auth stateful, like production", async () => {
    const context = await auth.$context;
    assert.ok(context.options.database);
    assert.equal(context.sessionConfig.cookieRefreshCache, false);
  });

  it("refuses a revoked session at once on high-impact paths (BA-10)", async () => {
    assert.deepEqual(await as(laptop.jar, "action", () => setAnthropicKey("sk-ant-laptop-key")), {
      ok: true,
    });
    const storedKey = async () =>
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).anthropicKeyEnc;
    const keyBefore = await storedKey();
    assert.ok(keyBefore);

    assert.equal((await laptop("/revoke-other-sessions", {})).status, 200);
    const [laptopToken] = await sessionTokens();
    assert.equal((await sessionTokens()).length, 1);

    // Control: ordinary requests still trust the thief's cookie cache for its
    // last seconds, so every refusal below comes from the DB read.
    assert.equal(await as(thief.jar, "action", () => requireUserId()), userId);

    await as(thief.jar, "action", async () => {
      await assert.rejects(requireUserId({ skipCookieCache: true }), signedOut);
      assert.equal(await getSession({ skipCookieCache: true }), null);
      await assert.rejects(setAnthropicKey("sk-ant-thief-key"), signedOut);
      await assert.rejects(removeAnthropicKey(), signedOut);
      assert.equal((await backupRoute.GET()).status, 401);
      const restore = await restoreRoute.POST(
        new Request(`${origin}/api/backup/restore`, { method: "POST", body: "{}" }),
      );
      assert.equal(restore.status, 401);
    });
    assert.equal(await storedKey(), keyBefore);

    const refused: Array<[path: string, body: unknown]> = [
      ["/delete-user", { password }],
      ["/revoke-session", { token: laptopToken }],
      ["/revoke-other-sessions", {}],
      ["/two-factor/enable", { password }],
      ["/two-factor/generate-backup-codes", { password }],
      ["/two-factor/disable", { password }],
      // With the cache, verify-totp would treat this as a signed-in device and,
      // after an enable, mint it a new session.
      ["/two-factor/verify-totp", { code: "000000" }],
    ];
    for (const [path, body] of refused) {
      assert.equal((await thief(path, body)).status, 401, path);
    }
    assert.deepEqual(await sessionTokens(), [laptopToken]);
    assert.equal(await prisma.twoFactor.count({ where: { userId } }), 0);

    // A live session still gets through the DB-checked path.
    assert.equal((await as(laptop.jar, "action", () => backupRoute.GET())).status, 200);
  });

  it("updateProfile can't keep a revoked session alive", async () => {
    const renameAsThief = async () => {
      thief.jar.writes = [];
      await as(thief.jar, "action", () =>
        assert.rejects(updateProfile("Thief"), /Unauthorized|signed out/),
      );
      const reissued = thief.jar.writes.filter((w) => w.name.endsWith("session_data") && w.value);
      assert.deepEqual(reissued, [], "no fresh cookie cache for a revoked session");
    };

    // Inside the cache window, then every 30 s, as a keep-alive script would.
    await renameAsThief();
    advance(30);
    await renameAsThief();
    advance(31);

    // Past the cache window: out everywhere, and the name never changed.
    await renameAsThief();
    await as(thief.jar, "action", () => assert.rejects(requireUserId(), signedOut));
    assert.equal(await as(thief.jar, "render", () => getOptionalUser()), null);
    assert.equal((await thief("/get-session", undefined, "GET")).json, null);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.name, "Owner");
  });

  it("a valid rename still reaches the cookie cache the next render reads", async () => {
    // Once with the laptop's cache expired, once with it fresh.
    for (const name of ["Renamed", "Renamed again"]) {
      assert.deepEqual(await as(laptop.jar, "action", () => updateProfile(name)), { ok: true });
      laptop.jar.writes = [];
      assert.equal((await as(laptop.jar, "render", () => requireUser())).name, name);
      assert.deepEqual(laptop.jar.writes, [], "renders don't write cookies");
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    assert.equal(user.name, "Renamed again");
  });

  it("turning 2FA on and signing in with it still work with DB-checked lookups", async () => {
    const enabled = await laptop("/two-factor/enable", { password });
    assert.equal(enabled.status, 200);
    const { totpURI } = enabled.json as { totpURI: string };
    assert.equal((await laptop("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    assert.equal((await laptop("/revoke-other-sessions", {})).status, 200);
    const [rotated] = await sessionTokens();
    const current = await laptop("/get-session?disableCookieCache=true", undefined, "GET");
    const { user, session } = current.json as {
      user: { twoFactorEnabled: boolean };
      session: { token: string };
    };
    assert.equal(user.twoFactorEnabled, true);
    assert.equal(session.token, rotated, "verify-totp's new session is the one kept");
    assert.equal(
      (await laptop("/two-factor/generate-backup-codes", { password })).status,
      200,
    );

    // A sign-in's verify-totp has no session cookie and is unaffected.
    advance(30); // a fresh TOTP step
    const phone = device("192.0.2.30");
    const signIn = await phone("/sign-in/email", { email, password });
    assert.equal((signIn.json as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);
    assert.equal((await phone("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    const phoneSession = await phone("/get-session", undefined, "GET");
    assert.equal((phoneSession.json as { user: { id: string } }).user.id, userId);
  });
});
