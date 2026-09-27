import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

async function source(path: string) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

// The 10-character rule lived only in a placeholder, which disappears on the
// first keystroke, and Change password sat disabled with no reason (JK-12).
describe("password rule is visible and explained (JK-12)", () => {
  it("settings shows the rule, keeps Change password enabled and explains on submit", async () => {
    const settings = await source("../src/app/(app)/settings/settings-client.tsx");
    const section = settings.slice(
      settings.indexOf("function PasswordSection()"),
      settings.indexOf("interface DeviceSession"),
    );
    assert.doesNotMatch(section, /placeholder="At least 10 characters"/);
    assert.match(section, /aria-describedby="settings-new-password-help"/);
    assert.match(section, /id="settings-new-password-help"[\s\S]*?Use at least 10 characters\./);

    const button = section.slice(section.lastIndexOf("<Button"), section.lastIndexOf("</Button>"));
    assert.match(button, /disabled=\{pending\}/);
    assert.doesNotMatch(button, /next\.length/);

    const submit = section.slice(section.indexOf("onSubmit="), section.indexOf("start("));
    assert.match(submit, /if \(!current \|\| next\.length < 10\)/);
    assert.match(submit, /flushSync\([\s\S]*setInvalid\(field\)[\s\S]*\.focus\(\);\s*return;/);
    assert.match(section, /aria-invalid=\{invalid === "current" \|\| undefined\}/);
    assert.match(section, /aria-invalid=\{invalid === "new" \|\| undefined\}/);
    assert.match(section, /id="settings-current-password-error"[\s\S]*?Enter your current password\./);
  });

  it("announces the message when Enter is pressed in the already-focused field", async () => {
    const settings = await source("../src/app/(app)/settings/settings-client.tsx");
    // focus() on the focused field fires nothing, so the messages must be live.
    assert.match(settings, /id="settings-current-password-error"\s+role="alert"/);
    assert.match(
      settings,
      /id="settings-new-password-help"\s+aria-live="polite"\s+aria-atomic="true"/,
    );
  });

  it("sign-up shows the rule as help text next to the Caps Lock warning", async () => {
    const auth = await source("../src/app/login/auth-form.tsx");
    assert.doesNotMatch(auth, /At least 10 characters/);
    assert.match(auth, /id="login-password-help"[\s\S]*?Use at least 10 characters\./);
    assert.match(
      auth,
      /\[isSignup && "login-password-help", capsLockOn && "login-caps-lock"\]/,
    );
  });
});
