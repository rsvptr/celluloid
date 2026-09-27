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
