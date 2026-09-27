import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MouseEvent } from "react";
import { toast } from "sonner";
import { UNDO_TOAST_DURATION, undoToast } from "../src/lib/undo-toast";

// Sonner's store works without a mounted <Toaster>: every create or update on
// an id is recorded, and getHistory() returns the merged state per toast.
function current(id: string | number) {
  const found = toast.getHistory().find((t) => t.id === id);
  assert.ok(found, `toast ${id} exists`);
  return found as typeof found & {
    title?: unknown;
    type?: string;
    duration?: number;
    closeButton?: boolean;
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

describe("undo toasts outlast Sonner's default and can be closed (JK-07)", () => {
  it("lives 10 s with a close button, then the outcome gets the default 4 s", async () => {
    const id = undoToast("Moved to Trash", {
      undo: async () => ({}),
      success: "Restored to your library",
      failure: "Couldn't undo that. Restore the title from Trash.",
    });
    assert.equal(UNDO_TOAST_DURATION, 10_000);
    assert.equal(current(id).duration, UNDO_TOAST_DURATION);
    assert.equal(current(id).closeButton, true);

    clickUndo(id);
    await settle();
    assert.equal(current(id).type, "success");
    assert.equal(current(id).duration, 4000, "the confirmation doesn't inherit the 10 s");
  });
});

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
