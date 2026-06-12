import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

// getKey() reads the env at call time, so setting it here is enough.
process.env.ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";

describe("crypto", () => {
  it("round-trips a secret", () => {
    const secret = "sk-ant-api03-roundtrip-test";
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  });

  it("uses a fresh IV per encryption", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptSecret("tamper-me");
    const [iv, tag, data] = payload.split(":");
    const flipped = data.slice(0, -2) + (data.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => decryptSecret(`${iv}:${tag}:${flipped}`));
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => decryptSecret("not-a-valid-payload"));
  });
});
