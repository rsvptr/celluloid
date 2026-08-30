import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { consumeSignupInvite, matchesSignupInvite } from "../src/lib/signup-invite";

describe("signup invite codes", () => {
  it("accepts only an exact configured code", () => {
    const expected = "bTWuc8tqigK3J5FpYpbQcPhA";

    assert.equal(matchesSignupInvite(expected, expected), true);
    assert.equal(matchesSignupInvite(expected.toLowerCase(), expected), false);
    assert.equal(matchesSignupInvite(` ${expected}`, expected), false);
  });

  it("stays closed for missing, empty, or non-string values", () => {
    assert.equal(matchesSignupInvite(undefined, "configured-invite"), false);
    assert.equal(matchesSignupInvite(123, "configured-invite"), false);
    assert.equal(matchesSignupInvite("configured-invite", undefined), false);
    assert.equal(matchesSignupInvite("", ""), false);
  });

  it("removes a valid code from the body before account creation", () => {
    const body = { inviteCode: "configured-invite", name: "Romy" };

    assert.equal(consumeSignupInvite(body, "configured-invite"), true);
    assert.deepEqual(body, { name: "Romy" });
  });
});
