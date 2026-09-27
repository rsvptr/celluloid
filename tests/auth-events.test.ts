import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { after, before, beforeEach, describe, it } from "node:test";

// The auth audit trail (BA-15) against Postgres: Better Auth on in-memory
// PGlite with the repo's migrations, the generated Prisma client and the real
// src/lib/auth.ts, driven over HTTP like a browser. Same harness as
// tests/auth-db.test.ts, cut down to what the events need.

// Lets the test step past a TOTP window. Installed before anything reads the time.
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

const origin = "http://localhost:3000";
const secret = "isolated-auth-events-test-secret-123456789012";

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");

const db = await PGlite.create();
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter((entry) => /^\d/.test(entry)).sort()) {
  await db.exec(readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"));
}
const server = new PGLiteSocketServer({ db, port: 0 });
await server.start();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
    max: 1,
  }),
});

// The app sees this client, with a switch that makes every audit table call fail.
let failAuditWrites = false;
const appPrisma = new Proxy(prisma, {
  get(target, property) {
    if (property === "authEvent" && failAuditWrites) {
      const fail = async () => {
        throw new Error("audit table unavailable");
      };
      return { create: fail, deleteMany: fail, findMany: fail };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

Object.assign(globalThis, {
  __CELLULOID_AUTH_EVENTS_ENV__: {
    BETTER_AUTH_URL: origin,
    NEXT_PUBLIC_SITE_URL: origin,
    BETTER_AUTH_SECRET: secret,
    SIGNUP_INVITE_CODE: "test-invite",
  },
  __CELLULOID_AUTH_EVENTS_PRISMA__: appPrisma,
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
    return stub("export const env = globalThis.__CELLULOID_AUTH_EVENTS_ENV__;");
  }
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return stub("export const prisma = globalThis.__CELLULOID_AUTH_EVENTS_PRISMA__;");
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { auth } = await import("../src/lib/auth");
const {
  AUTH_EVENT_RETENTION_DAYS,
  RECENT_AUTH_EVENT_LIMIT,
  USER_AGENT_MAX_LENGTH,
  authEventRetentionCutoff,
  getRecentAuthEvents,
  pruneAuthEvents,
} = await import("../src/lib/auth-events");

/** Runs `fn` with console.error captured, and returns the logged lines. */
async function captureErrors(fn: () => Promise<void>): Promise<string[]> {
  const logged: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return logged.map((args) => args.map(String).join(" "));
}

/** A browser: its cookie jar, IP and user agent, calling the auth HTTP handler. */
function device(ip: string, userAgent: string) {
  const jar = new Map<string, string>();
  const call = async (path: string, body?: unknown) => {
    const response = await auth.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-forwarded-for": ip,
          "user-agent": userAgent,
          cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
    for (const raw of response.headers.getSetCookie()) {
      const [pair, ...attributes] = raw.split(";");
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1);
      if (value === "" || attributes.some((a) => /max-age=0/i.test(a.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
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

const email = "auth-events@example.test";
const password = "synthetic-password-24680";
const newPassword = "synthetic-password-13579";
// Longer than the stored cap, so every row shows the cut.
const laptopAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/140.0 ${"x".repeat(300)}`;
const laptop = device("192.0.2.10", laptopAgent);
const phone = device("192.0.2.20", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/604.1");
let userId = "";
let seen = 0;

/** Events written since the last call, oldest first. */
async function newEvents() {
  const rows = await prisma.authEvent.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  const fresh = rows.slice(seen);
  seen = rows.length;
  return fresh;
}

async function newTypes() {
  return (await newEvents()).map((row) => row.type);
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
});

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

beforeEach(() => {
  failAuditWrites = false;
});

describe("auth audit trail against Postgres (BA-15)", { concurrency: false }, () => {
  it("records sign-up as a sign-in, with the IP and a cut user agent, and no email", async () => {
    const [event, ...rest] = await newEvents();
    assert.equal(rest.length, 0);
    assert.equal(event.type, "sign_in");
    assert.equal(event.ipAddress, "192.0.2.10");
    assert.equal(event.userAgent, laptopAgent.slice(0, USER_AGENT_MAX_LENGTH));
    assert.equal(event.userAgent?.length, USER_AGENT_MAX_LENGTH);
    assert.deepEqual(Object.keys(event).sort(), [
      "createdAt",
      "id",
      "ipAddress",
      "type",
      "userAgent",
      "userId",
    ]);
  });

  it("records a sign-in, and nothing for a wrong password", async () => {
    assert.equal((await phone("/sign-in/email", { email, password: "not-my-password" })).status, 401);
    assert.deepEqual(await newTypes(), []);

    assert.equal((await phone("/sign-in/email", { email, password })).status, 200);
    const [event] = await newEvents();
    assert.equal(event.type, "sign_in");
    assert.equal(event.ipAddress, "192.0.2.20");
  });

  it("records revoking one device from the device that did it, and nothing for an unknown token", async () => {
    assert.equal((await laptop("/revoke-session", { token: "no-such-token" })).status, 200);
    assert.deepEqual(await newTypes(), []);

    const { token } = await prisma.session.findFirstOrThrow({
      where: { userId, userAgent: { contains: "iPhone" } },
    });
    assert.equal((await laptop("/revoke-session", { token })).status, 200);
    const [event, ...rest] = await newEvents();
    assert.equal(rest.length, 0);
    assert.equal(event.type, "session_revoked");
    assert.equal(event.ipAddress, "192.0.2.10");
  });

  it("records signing out everywhere else", async () => {
    assert.equal((await phone("/sign-in/email", { email, password })).status, 200);
    assert.deepEqual(await newTypes(), ["sign_in"]);
    assert.equal((await laptop("/revoke-other-sessions")).status, 200);
    assert.deepEqual(await newTypes(), ["other_sessions_revoked"]);
  });

  it("records a password change once, not its new session, and nothing for a wrong password", async () => {
    const wrong = await laptop("/change-password", {
      currentPassword: "not-my-password",
      newPassword,
      revokeOtherSessions: true,
    });
    assert.equal(wrong.status, 400);
    assert.deepEqual(await newTypes(), []);

    const changed = await laptop("/change-password", {
      currentPassword: password,
      newPassword,
      revokeOtherSessions: true,
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(await newTypes(), ["password_changed"]);
  });

  let totpURI = "";

  it("records turning 2FA on at the confirming code, not at setup or its session swap", async () => {
    const enabled = await laptop("/two-factor/enable", { password: newPassword });
    assert.equal(enabled.status, 200);
    totpURI = (enabled.json as { totpURI: string }).totpURI;
    assert.deepEqual(await newTypes(), [], "starting setup changes nothing yet");

    assert.equal((await laptop("/two-factor/verify-totp", { code: "000000" })).status, 401);
    assert.deepEqual(await newTypes(), []);

    assert.equal((await laptop("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    assert.deepEqual(await newTypes(), ["two_factor_enabled"]);

    // A second good code while 2FA is on changes nothing.
    assert.equal((await laptop("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    assert.deepEqual(await newTypes(), []);
  });

  it("records replacing the authenticator key while 2FA is on", async () => {
    const replaced = await laptop("/two-factor/enable", { password: newPassword });
    assert.equal(replaced.status, 200);
    totpURI = (replaced.json as { totpURI: string }).totpURI;
    assert.deepEqual(await newTypes(), ["two_factor_secret_replaced"]);
  });

  it("records regenerating backup codes, and nothing for a wrong password", async () => {
    assert.equal(
      (await laptop("/two-factor/generate-backup-codes", { password: "not-my-password" })).status,
      400,
    );
    assert.deepEqual(await newTypes(), []);
    assert.equal(
      (await laptop("/two-factor/generate-backup-codes", { password: newPassword })).status,
      200,
    );
    assert.deepEqual(await newTypes(), ["backup_codes_regenerated"]);
  });

  it("records one sign-in for a 2FA sign-in, at the code, not at the password step", async () => {
    const step = await phone("/sign-in/email", { email, password: newPassword });
    assert.equal(step.status, 200);
    assert.equal((step.json as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);
    assert.deepEqual(await newTypes(), [], "the password step's session is deleted, not a sign-in");

    offsetMs += 30_000; // a fresh TOTP step
    assert.equal((await phone("/two-factor/verify-totp", { code: "000000" })).status, 401);
    assert.deepEqual(await newTypes(), []);
    assert.equal((await phone("/two-factor/verify-totp", { code: totpCode(totpURI) })).status, 200);
    const [event, ...rest] = await newEvents();
    assert.equal(rest.length, 0);
    assert.equal(event.type, "sign_in", "not two_factor_enabled");
    assert.equal(event.ipAddress, "192.0.2.20");
  });

  it("records one sign-in for a backup-code sign-in", async () => {
    const codes = await laptop("/two-factor/generate-backup-codes", { password: newPassword });
    const [code] = (codes.json as { backupCodes: string[] }).backupCodes;
    assert.deepEqual(await newTypes(), ["backup_codes_regenerated"]);

    const tablet = device("192.0.2.30", "Mozilla/5.0 (iPad; CPU OS 18_0) Safari/604.1");
    assert.equal((await tablet("/sign-in/email", { email, password: newPassword })).status, 200);
    assert.equal((await tablet("/two-factor/verify-backup-code", { code })).status, 200);
    assert.deepEqual(await newTypes(), ["sign_in"]);
    assert.equal((await tablet("/sign-out")).status, 200);
    assert.deepEqual(await newTypes(), ["sign_out"]);
  });

  it("records turning 2FA off once, not its session swap", async () => {
    assert.equal((await laptop("/two-factor/disable", { password: "not-my-password" })).status, 400);
    assert.deepEqual(await newTypes(), []);
    assert.equal((await laptop("/two-factor/disable", { password: newPassword })).status, 200);
    assert.deepEqual(await newTypes(), ["two_factor_disabled"]);
  });

  it("records a sign-out, and nothing for one without a session", async () => {
    assert.equal((await phone("/sign-out")).status, 200);
    assert.deepEqual(await newTypes(), ["sign_out"]);
    assert.equal((await phone("/sign-out")).status, 200);
    assert.deepEqual(await newTypes(), []);
  });

  it("records signing out everywhere at once, and nothing for a request without a session", async () => {
    assert.equal((await phone("/revoke-sessions")).status, 401);
    assert.deepEqual(await newTypes(), []);
    assert.equal((await laptop("/revoke-sessions")).status, 200);
    assert.equal(await prisma.session.count({ where: { userId } }), 0);
    assert.deepEqual(await newTypes(), ["all_sessions_revoked"], "one event, not one per session");
  });

  it("still signs in, changes the password and signs out when every audit write fails", async () => {
    const logged: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    failAuditWrites = true;
    try {
      const signIn = await phone("/sign-in/email", { email, password: newPassword });
      assert.equal(signIn.status, 200);
      assert.ok(phone.jar.get("better-auth.session_token"), "the session cookie is still set");
      const changed = await phone("/change-password", {
        currentPassword: newPassword,
        newPassword: password,
        revokeOtherSessions: false,
      });
      assert.equal(changed.status, 200);
      assert.equal((await phone("/sign-out")).status, 200);
      assert.equal(phone.jar.get("better-auth.session_token"), undefined);
    } finally {
      failAuditWrites = false;
      console.error = realError;
    }
    assert.deepEqual(await newTypes(), []);
    const lines = logged.map((args) => args.map(String).join(" "));
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.match(line, /^Could not record the (sign_in|password_changed|sign_out) auth event for user /);
      assert.doesNotMatch(line, new RegExp(email.replace(".", "\\.")));
    }
  });

  it("never stores the email", async () => {
    const rows = await prisma.authEvent.findMany({ where: { userId } });
    assert.ok(rows.length >= 12);
    assert.doesNotMatch(JSON.stringify(rows), /auth-events@example/);
  });

  it("goes when the user does", async () => {
    await prisma.user.delete({ where: { id: userId } });
    assert.equal(await prisma.authEvent.count({ where: { userId } }), 0);
  });
});

describe("auth events retention and the Settings list (BA-15)", { concurrency: false }, () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const now = new Date("2026-09-27T12:00:00.000Z");
  const cutoff = authEventRetentionCutoff(now).getTime();

  before(async () => {
    await prisma.user.createMany({
      data: ["keep-a", "keep-b"].map((id) => ({ id, name: id, email: `${id}@example.test` })),
    });
  });

  it("cuts off exactly 90 days before now", () => {
    assert.equal(AUTH_EVENT_RETENTION_DAYS, 90);
    assert.equal(new Date(cutoff).toISOString(), "2026-06-29T12:00:00.000Z");
    assert.equal(now.getTime() - cutoff, 90 * DAY_MS);
  });

  it("prunes every user's events older than the cutoff and keeps the rest", async () => {
    const kept = [cutoff, cutoff + 1, now.getTime() - DAY_MS];
    const pruned = [cutoff - 1, cutoff - DAY_MS];
    await prisma.authEvent.createMany({
      data: ["keep-a", "keep-b"].flatMap((userId) =>
        [...kept, ...pruned].map((at) => ({ userId, type: "sign_in", createdAt: new Date(at) })),
      ),
    });

    await pruneAuthEvents(now);

    for (const userId of ["keep-a", "keep-b"]) {
      const left = await prisma.authEvent.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
      assert.deepEqual(
        left.map((row) => row.createdAt.getTime()),
        kept,
      );
    }
  });

  it("never throws when the prune fails", async () => {
    failAuditWrites = true;
    const lines = await captureErrors(() => pruneAuthEvents(now)).finally(() => {
      failAuditWrites = false;
    });
    assert.deepEqual(lines, ["Could not prune old auth events: audit table unavailable"]);
  });

  it("lists the user's latest 20 events, newest first, and nobody else's", async () => {
    await prisma.authEvent.createMany({
      data: Array.from({ length: 25 }, (_, i) => ({
        userId: "keep-a",
        type: "sign_out",
        ipAddress: `192.0.2.${i}`,
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0",
        createdAt: new Date(now.getTime() + i * 1000),
      })),
    });

    const events = await getRecentAuthEvents("keep-a");
    assert.ok(events);
    assert.equal(RECENT_AUTH_EVENT_LIMIT, 20);
    assert.equal(events.length, 20);
    assert.deepEqual(
      events.map((event) => event.createdAt),
      Array.from({ length: 20 }, (_, i) => new Date(now.getTime() + (24 - i) * 1000).toISOString()),
    );
    assert.deepEqual(Object.keys(events[0]).sort(), ["createdAt", "id", "ipAddress", "type", "userAgent"]);
    assert.deepEqual(events[0], {
      id: events[0].id,
      type: "sign_out",
      ipAddress: "192.0.2.24",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0",
      createdAt: new Date(now.getTime() + 24_000).toISOString(),
    });

    const other = await getRecentAuthEvents("keep-b");
    assert.ok(other);
    assert.deepEqual(
      other.map((event) => event.createdAt),
      [now.getTime() - DAY_MS, cutoff + 1, cutoff].map((at) => new Date(at).toISOString()),
    );
  });

  it("returns null instead of throwing when the list can't be read", async () => {
    failAuditWrites = true;
    let events: Awaited<ReturnType<typeof getRecentAuthEvents>> | undefined;
    const lines = await captureErrors(async () => {
      events = await getRecentAuthEvents("keep-a");
    }).finally(() => {
      failAuditWrites = false;
    });
    assert.equal(events, null);
    assert.deepEqual(lines, ["Could not load auth events for user keep-a: audit table unavailable"]);
  });
});

describe("nightly prune wiring", () => {
  it("prunes from the cron route after the secret check, inside the run's budget", () => {
    const cron = readFileSync(new URL("../src/app/api/cron/sync/route.ts", import.meta.url), "utf8");
    assert.match(
      cron,
      /if \(!isAuthorizedCron\(request\)\) \{[\s\S]*?\n {2}\}\n\n {2}const runStartedAt = new Date\(\);[\s\S]*?await pruneAuthEvents\(\);[\s\S]*?runScheduledSync\(\{ deadline: runStartedAt\.getTime\(\) \+ RUN_BUDGET_MS \}\)/,
    );
  });
});

describe("auth.ts wiring", () => {
  const source = readFileSync(new URL("../src/lib/auth.ts", import.meta.url), "utf8");

  it("records sign-ins and session ends from database hooks, and changes from an after hook", () => {
    assert.match(source, /hooks: \{ before: enforceAuthRequestPolicy, after: recordAccountChange \}/);
    assert.match(
      source,
      /databaseHooks: \{\s*session: \{\s*create: \{\s*async after\(session, context\) \{\s*if \(isSignIn\(session, context\)\) await recordAuthEvent\(session\.userId, "sign_in", context\);/,
    );
    assert.match(
      source,
      /delete: \{\s*async after\(session, context\) \{\s*const type = context \? sessionEndEvents\.get\(context\.path\) : undefined;\s*if \(type\) await recordAuthEvent\(session\.userId, type, context\);/,
    );
    assert.match(source, /if \(!session \|\| isAPIError\(ctx\.context\.returned\)\) return;/);
  });
});
