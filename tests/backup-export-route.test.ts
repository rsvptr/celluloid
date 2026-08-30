import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";
import { MAX_BACKUP_BYTES } from "../src/lib/backup-format";

let envelope: Record<string, unknown> = {};
let stampCalls = 0;
Object.assign(globalThis, {
  __CELLULOID_BACKUP_EXPORT_ENVELOPE__: envelope,
  __CELLULOID_BACKUP_EXPORT_STAMP__: () => {
    stampCalls += 1;
  },
});

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
    assert.equal(stampCalls, 1);
  });
});
