import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";

// getKey() reads the env at call time, so setting it here is enough.
const TEST_SECRET = "test-only-encryption-key-not-a-real-secret";
process.env.ENCRYPTION_KEY = TEST_SECRET;

/**
 * Produces a payload exactly as the pre-HKDF code did: unsalted SHA-256 of the
 * secret, no version prefix. Rows in this shape are already in the production
 * database, so the reader has to keep understanding them forever.
 */
function encryptLegacy(plain: string): string {
  const key = crypto.createHash("sha256").update(TEST_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

describe("crypto", () => {
  it("round-trips a secret", () => {
    const secret = "sk-ant-api03-roundtrip-test";
    assert.equal(decryptSecret(encryptSecret(secret)), secret);
  });

  it("writes new ciphertext with the v1 prefix", () => {
    const parts = encryptSecret("sk-ant-api03-version-test").split(":");
    assert.equal(parts.length, 4);
    assert.equal(parts[0], "v1");
  });

  it("round-trips a legacy, unprefixed payload", () => {
    const secret = "sk-ant-api03-legacy-test";
    const legacy = encryptLegacy(secret);
    assert.equal(legacy.split(":").length, 3);
    assert.equal(decryptSecret(legacy), secret);
  });

  it("rejects an unknown version prefix", () => {
    const [, iv, tag, data] = encryptSecret("future-format").split(":");
    assert.throws(() => decryptSecret(`v2:${iv}:${tag}:${data}`));
  });

  it("uses a fresh IV per encryption", () => {
    const a = encryptSecret("same-input");
    const b = encryptSecret("same-input");
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), decryptSecret(b));
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptSecret("tamper-me");
    const [version, iv, tag, data] = payload.split(":");
    const flipped = data.slice(0, -2) + (data.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => decryptSecret(`${version}:${iv}:${tag}:${flipped}`));
  });

  it("rejects tampered legacy ciphertext", () => {
    const [iv, tag, data] = encryptLegacy("tamper-me-too").split(":");
    const flipped = data.slice(0, -2) + (data.endsWith("AA") ? "BB" : "AA");
    assert.throws(() => decryptSecret(`${iv}:${tag}:${flipped}`));
  });

  it("rejects malformed payloads", () => {
    assert.throws(() => decryptSecret("not-a-valid-payload"));
  });
});
