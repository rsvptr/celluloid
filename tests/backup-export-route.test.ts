import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { MAX_BACKUP_BYTES } from "../src/lib/backup-format";

let envelope: Record<string, unknown> = {};
let stampCalls = 0;
let stampError: Error | null = null;
// Callbacks the route hands to next/server's after(), run once the response
// is out (there is no request scope in a test, so the real one would throw).
const afterCallbacks: Array<() => unknown> = [];
Object.assign(globalThis, {
  __CELLULOID_BACKUP_EXPORT_ENVELOPE__: envelope,
  __CELLULOID_BACKUP_EXPORT_STAMP__: () => {
    stampCalls += 1;
    if (stampError) throw stampError;
  },
  __CELLULOID_BACKUP_EXPORT_AFTER__: afterCallbacks,
});

async function runAfterCallbacks() {
  for (const callback of afterCallbacks.splice(0)) await callback();
}

const loader = `
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  if (specifier === "@/lib/backup" || normalized.endsWith("/src/lib/backup")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function createBackupEnvelope() { return globalThis.__CELLULOID_BACKUP_EXPORT_ENVELOPE__; }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "next/server") {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export function after(callback) { globalThis.__CELLULOID_BACKUP_EXPORT_AFTER__.push(callback); }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/prisma" || normalized.endsWith("/src/lib/prisma")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export const prisma = { user: { update: async () => { globalThis.__CELLULOID_BACKUP_EXPORT_STAMP__(); } } };",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/rate-limit" || normalized.endsWith("/src/lib/rate-limit")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export function rateLimit() { return { ok: true }; }" +
        "export function tooManyRequests() { throw new Error('unexpected rate limit'); }",
      ),
      shortCircuit: true,
    };
  }
  if (specifier === "@/lib/session" || normalized.endsWith("/src/lib/session")) {
    return {
      url: "data:text/javascript," + encodeURIComponent(
        "export async function getSession() { return { user: { id: 'user-1' } }; }",
      ),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const { GET } = await import("../src/app/api/backup/route");

describe("backup export restore-size guard", { concurrency: false }, () => {
  it("stops an over-limit download before stamping backup freshness", async () => {
    envelope = {
      exportedAt: "2026-08-29T00:00:00.000Z",
      payload: "x".repeat(MAX_BACKUP_BYTES),
    };
    Object.assign(globalThis, { __CELLULOID_BACKUP_EXPORT_ENVELOPE__: envelope });
    stampCalls = 0;

    const response = await GET();
    const body = (await response.json()) as { error?: string };

    assert.equal(response.status, 413);
    assert.match(body.error ?? "", /larger than the 4 MB restore limit/);
    assert.equal(afterCallbacks.length, 0);
    assert.equal(stampCalls, 0);
  });

  it("downloads a restorable backup with its exact byte length", async () => {
    envelope = {
      app: "celluloid",
      schemaVersion: 2,
      exportedAt: "2026-08-29T00:00:00.000Z",
    };
    Object.assign(globalThis, { __CELLULOID_BACKUP_EXPORT_ENVELOPE__: envelope });
    stampCalls = 0;

    const response = await GET();
    const bytes = new Uint8Array(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(bytes.byteLength));
    assert.match(response.headers.get("content-disposition") ?? "", /celluloid-backup-/);
    // VE-15: the freshness stamp waits until after the response (after()).
    assert.equal(stampCalls, 0);
    await runAfterCallbacks();
    assert.equal(stampCalls, 1);
  });

  it("logs and swallows a failed freshness stamp", async () => {
    envelope = { exportedAt: "2026-08-29T00:00:00.000Z" };
    Object.assign(globalThis, { __CELLULOID_BACKUP_EXPORT_ENVELOPE__: envelope });
    stampCalls = 0;
    stampError = new Error("db down");
    const logged: unknown[][] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const response = await GET();
      assert.equal(response.status, 200);
      await runAfterCallbacks();
      assert.equal(stampCalls, 1);
      assert.equal(logged.length, 1);
      assert.match(String(logged[0][0]), /could not record lastBackupAt/);
      assert.equal(logged[0][1], stampError);
    } finally {
      console.error = originalError;
      stampError = null;
    }
  });
});
