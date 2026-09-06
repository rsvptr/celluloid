import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

// AUD-45 / D-022: share-actions.ts used to call requireUserId(), which throws
// when signed out. A rejection inside an async startTransition callback in
// React 19 reaches the nearest error boundary, replacing the whole (app)
// segment with the generic error page. Every exported action must instead
// resolve normally with an error result, like the other action modules do.
//
// The session is mocked to null throughout; every action here must return
// before touching prisma, so prisma itself does not need mocking.
const mockModules = new Map<string, string>([
  ["@/lib/session", "export async function getSession() { return null; }"],
  ["next/cache", "export function revalidatePath() {}"],
]);
const loader = `
const modules = new Map(${JSON.stringify([...mockModules])});
export async function resolve(specifier, context, nextResolve) {
  const normalized = specifier.replaceAll("\\\\", "/").replace(/\\.ts$/, "");
  const source =
    modules.get(specifier) ??
    (normalized.endsWith("/src/lib/session")
      ? modules.get("@/lib/session")
      : undefined);
  if (source !== undefined) {
    return {
      url: "data:text/javascript," + encodeURIComponent(source),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);

const {
  createShareList,
  deleteShareList,
  revokeShareList,
  restoreShareList,
  renameShareList,
  setShareExpiry,
  getShareListTitles,
} = await import("../src/lib/share-actions");

const SIGNED_OUT = { error: "You're signed out. Sign in and try again." };

describe("share-actions signed-out handling", { concurrency: false }, () => {
  it("createShareList resolves to an error instead of rejecting", async () => {
    assert.deepEqual(await createShareList({}), SIGNED_OUT);
  });

  it("getShareListTitles resolves to an error instead of rejecting", async () => {
    assert.deepEqual(await getShareListTitles("share-1"), SIGNED_OUT);
  });

  it("deleteShareList resolves to { ok: false } instead of rejecting", async () => {
    assert.deepEqual(await deleteShareList("share-1"), { ok: false });
  });

  it("revokeShareList resolves to { ok: false } instead of rejecting", async () => {
    assert.deepEqual(await revokeShareList("share-1"), { ok: false });
  });

  it("restoreShareList resolves to { ok: false } instead of rejecting", async () => {
    assert.deepEqual(await restoreShareList("share-1"), { ok: false });
  });

  it("renameShareList resolves to { ok: false } instead of rejecting", async () => {
    assert.deepEqual(await renameShareList("share-1", "New name"), { ok: false });
  });

  it("setShareExpiry resolves to { ok: false } instead of rejecting", async () => {
    assert.deepEqual(await setShareExpiry("share-1", 7), { ok: false });
  });
});
