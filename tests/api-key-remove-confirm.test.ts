import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

// The API key's Remove button deleted the key on the first click, with no
// confirm and no undo (handoff pending item).
describe("API key Remove", () => {
  it("asks first, in the shared destructive confirm, then removes the key", async () => {
    const section = await readFile(
      new URL("../src/app/(app)/settings/api-key-section.tsx", import.meta.url),
      "utf8",
    );
    assert.match(section, /import \{ useConfirm \} from "@\/components\/confirm-dialog";/);
    assert.match(section, /const \{ confirm, dialog \} = useConfirm\(\);/);
    assert.match(section, /<>\s*\{dialog\}\s*<Section/);

    const remove = section.slice(section.indexOf("async function removeKey()"));
    const asked = remove.indexOf("await confirm({");
    const removed = remove.indexOf("removeAnthropicKey()");
    assert.ok(asked !== -1 && removed > asked, "the key is removed only after the confirm");
    const options = remove.slice(asked, remove.indexOf("}))", asked));
    assert.match(options, /title: "Remove your API key\?"/);
    assert.match(options, /confirmLabel: "Remove key"/);
    assert.match(options, /destructive: true/);
    // Both bodies say what happens next, in sentence case.
    assert.match(options, /"Recommendations will use the app's shared key, and any daily limit its owner set, until you add a key again\."/);
    assert.match(options, /"AI recommendations will stop working until you add a key again\."/);
    assert.match(remove, /if \(\s*!\(await confirm\(\{[^]*?\}\)\)\s*\)\s*return;/);
  });

  it("styles Remove like the other settings deletes", async () => {
    const section = await readFile(
      new URL("../src/app/(app)/settings/api-key-section.tsx", import.meta.url),
      "utf8",
    );
    const at = section.indexOf("void removeKey()");
    const button = section.slice(section.lastIndexOf("<Button", at), section.indexOf("</Button>", at));
    assert.match(button, /className=\{cn\("text-rose-300 hover:text-rose-200", softDisabledClass\)\}/);
  });
});
