import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { normalizeBackupCode } from "../src/app/login/auth-form";

async function twoFactorStep() {
  const file = await readFile(new URL("../src/app/login/auth-form.tsx", import.meta.url), "utf8");
  const start = file.indexOf("if (isTwoFa) {\n    return (");
  assert.notEqual(start, -1);
  return { file, step: file.slice(start, file.indexOf("</form>", start)) };
}

// A pasted backup code with a stray space failed and spent one of the sign-in's
// five attempts, and an expired challenge left no way out but a reload (BA-08).
describe("backup code input is normalized (BA-08)", () => {
  it("strips whitespace and dashes and restores the one dash", () => {
    assert.equal(normalizeBackupCode(" aB3dE-fG5hJ \n"), "aB3dE-fG5hJ");
    assert.equal(normalizeBackupCode("aB3dEfG5hJ"), "aB3dE-fG5hJ");
    assert.equal(normalizeBackupCode("aB3dE fG5hJ"), "aB3dE-fG5hJ");
    assert.equal(normalizeBackupCode("aB3 dE-fG 5hJ"), "aB3dE-fG5hJ");
    // Autocorrect and some apps turn the hyphen into an en dash or a minus sign.
    assert.equal(normalizeBackupCode("aB3dE\u2013fG5hJ"), "aB3dE-fG5hJ");
    assert.equal(normalizeBackupCode("aB3dE\u2212fG5hJ"), "aB3dE-fG5hJ");
  });

  it("keeps case, since codes are compared exactly", () => {
    assert.equal(normalizeBackupCode("ABCDE-fghij"), "ABCDE-fghij");
  });

  it("leaves a code of the wrong length for the server to reject", () => {
    assert.equal(normalizeBackupCode(" abc-de "), "abcde");
  });
});

describe("the 2FA sign-in step has a way back (BA-08)", () => {
  it("sends the normalized backup code, with no length cap to truncate a paste", async () => {
    const { file, step } = await twoFactorStep();
    assert.match(file, /verifyBackupCode\(\{ code: normalizeBackupCode\(code\) \}\)/);
    assert.match(step, /maxLength=\{useBackup \? undefined : 6\}/);
    assert.match(step, /placeholder=\{useBackup \? "xxxxx-xxxxx" : "123456"\}/);
  });

  it("offers Back to sign in and returns there when the challenge has expired", async () => {
    const { file, step } = await twoFactorStep();
    assert.match(
      step,
      /<button\s+type="button"\s+onClick=\{\(\) => backToSignIn\(null\)\}[\s\S]*?>\s*Back to sign in\s*<\/button>/,
    );
    for (const code of ["INVALID_TWO_FACTOR_COOKIE", "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE"]) {
      assert.match(
        file,
        new RegExp(`error\\?\\.code === "${code}"\\) \\{\\s*backToSignIn\\("[^"]+"\\);\\s*return;`),
      );
    }
    // A fresh sign-in needs the password again, so land there with it cleared.
    const back = file.slice(file.indexOf("function backToSignIn("), file.indexOf("async function onSubmit("));
    assert.match(back, /setMode\("signin"\)/);
    assert.match(back, /setPassword\(""\)/);
    assert.match(back, /getElementById\("login-password"\)\?\.focus\(\)/);
  });

  it("explains the rate limit instead of leaving a dead screen", async () => {
    // The limiter's 429 trips on the sixth backup code, before the challenge's
    // five-code cap, so it needs its own message (Back to sign in stays offered).
    const { file } = await twoFactorStep();
    const limited = file.indexOf("if (error?.status === 429");
    assert.notEqual(limited, -1);
    assert.ok(limited < file.indexOf("if (error) {"), "429 is handled before the generic error");
    assert.match(
      file.slice(limited),
      /^if \(error\?\.status === 429 && error\.code !== "ACCOUNT_TEMPORARILY_LOCKED"\) \{\s*setError\("Too many attempts\. Wait a minute, then try again\."\);\s*return;/,
    );
  });
});
