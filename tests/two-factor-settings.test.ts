import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

const settingsPath = "../src/app/(app)/settings/settings-client.tsx";

function between(file: string, start: string, end: string): string {
  const from = file.indexOf(start);
  assert.notEqual(from, -1, `marker not found: ${start}`);
  const to = file.indexOf(end, from);
  assert.notEqual(to, -1, `marker not found: ${end}`);
  return file.slice(from, to);
}

// A session stolen before 2FA was turned on kept working afterwards (BA-07).
describe("turning 2FA on signs out other devices (BA-07)", () => {
  it("revokes the other sessions only after the code verifies", async () => {
    const settings = await source(settingsPath);
    const confirmEnable = between(settings, "async function confirmEnable()", "async function disable()");
    const verify = confirmEnable.indexOf("authClient.twoFactor.verifyTotp(");
    const bail = confirmEnable.indexOf("return;", verify);
    const revoke = confirmEnable.indexOf("authClient.revokeOtherSessions()");
    const turnedOn = confirmEnable.indexOf("setOn(true)");
    assert.ok(verify !== -1 && bail > verify, "a failed verify returns early");
    assert.ok(revoke > bail, "revoke runs only after a successful verify");
    assert.ok(turnedOn > revoke, "the section switches to on after the revoke settles");
    // A failed revoke must not read as success: 2FA is on, the devices aren't out.
    assert.match(confirmEnable, /couldn't sign out your other devices/);
  });

  it("reloads the Devices list when 2FA flips", async () => {
    const settings = await source(settingsPath);
    assert.match(
      settings,
      /<DevicesSection key=\{info\.twoFactorEnabled \? "2fa-on" : "2fa-off"\} \/>/,
    );
  });
});

// Used or lost codes meant turning 2FA off and on again, re-scanning the QR
// code, just to get new ones (BA-09).
describe("regenerating backup codes (BA-09)", () => {
  it("is a password-gated POST form with a soft-disabled, guarded submit", async () => {
    const settings = await source(settingsPath);
    const marker = ": null} Regenerate backup codes";
    const at = settings.indexOf(marker);
    assert.notEqual(at, -1);
    const form = settings.slice(settings.lastIndexOf("<form", at), settings.indexOf("</form>", at));
    assert.match(form, /^<form\s+method="post"/);
    assert.match(form, /type="password"[\s\S]*?autoComplete="current-password"/);
    const button = form.slice(form.lastIndexOf("<Button", form.indexOf(marker)));
    assert.match(button, /type="submit"/);
    assert.match(button, /softDisabledClass/);
    assert.doesNotMatch(button, /\sdisabled=\{/);
    const condition = button.match(/aria-disabled=\{([^}]*)\}/)?.[1];
    assert.equal(condition, "codesBusy || !codesPassword");
    // Enter, or a password manager's requestSubmit, must respect the same state.
    assert.ok(form.includes(`if (${condition}) return;`));
  });

  it("sends the password to generateBackupCodes and shows the codes once, with copy and download", async () => {
    const settings = await source(settingsPath);
    const handler = between(settings, "async function regenerateBackupCodes()", "async function beginEnable()");
    assert.match(handler, /authClient\.twoFactor\.generateBackupCodes\(\{\s*password: codesPassword,?\s*\}\)/);
    assert.match(handler, /setCodesPassword\(""\)/);

    const panel = between(settings, 'id="settings-new-backup-codes"', "Done\n");
    assert.match(panel, /won&apos;t be shown again/);
    assert.match(panel, /copyText\(newCodes\.join\("\\n"\), "Backup codes copied"\)/);
    assert.match(panel, /saveBlob\(/);
    assert.match(panel, /"celluloid-backup-codes\.txt"/);
    // Turning 2FA off clears codes still on screen.
    assert.match(between(settings, "function reset()", "async function"), /setNewCodes\(null\)/);
  });
});
