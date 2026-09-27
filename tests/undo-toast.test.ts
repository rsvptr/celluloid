import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MouseEvent } from "react";
import { toast } from "sonner";
import { undoToast } from "../src/lib/undo-toast";

// Sonner's store works without a mounted <Toaster>: every create or update on
// an id is recorded, and getHistory() returns the merged state per toast.
function current(id: string | number) {
  const found = toast.getHistory().find((t) => t.id === id);
  assert.ok(found, `toast ${id} exists`);
  return found as typeof found & {
    title?: unknown;
    type?: string;
    action?: { onClick: (event: MouseEvent<HTMLButtonElement>) => void };
  };
}

function clickUndo(id: string | number) {
  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  } as MouseEvent<HTMLButtonElement>;
  current(id).action!.onClick(event);
  return prevented;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("undo toast updates in place (EM-06)", () => {
  it("keeps the toast, shows a spinner, then the confirmation on the same id", async () => {
    let finish!: (value: { error?: string }) => void;
    let succeeded = 0;
    const id = undoToast("Marked watched", {
      undo: () => new Promise((resolve) => (finish = resolve)),
      success: "Watched change undone",
      failure: "Couldn't undo that watched change. Try again.",
      onSuccess: () => (succeeded += 1),
    });

    assert.equal(clickUndo(id), true, "the click is default-prevented so Sonner keeps the toast");
    assert.equal(current(id).type, "loading");
    assert.equal(current(id).title, "Undoing…");
    assert.equal(current(id).action, undefined, "the Undo button goes away while pending");

    finish({});
    await settle();
    assert.equal(current(id).type, "success");
    assert.equal(current(id).title, "Watched change undone");
    assert.equal(succeeded, 1);
  });

  it("shows a returned error on the same toast and runs onError", async () => {
    let errored = 0;
    const id = undoToast("Moved to Trash", {
      undo: async () => ({ error: "Title not found" }),
      success: "Restored to your library",
      failure: "Couldn't undo that. Restore the title from Trash.",
      onError: () => (errored += 1),
    });
    clickUndo(id);
    await settle();
    assert.equal(current(id).type, "error");
    assert.equal(current(id).title, "Title not found");
    assert.equal(errored, 1);
  });

  it("shows the failure copy on the same toast when the undo throws", async () => {
    let errored = 0;
    const id = undoToast("Removed 3 titles", {
      undo: async () => {
        throw new Error("offline");
      },
      success: "Restored 3 titles",
      failure: "Couldn't restore every title. Check Trash and retry.",
      onError: () => (errored += 1),
    });
    clickUndo(id);
    await settle();
    assert.equal(current(id).type, "error");
    assert.equal(current(id).title, "Couldn't restore every title. Check Trash and retry.");
    assert.equal(errored, 1);
  });
});
