import crypto from "node:crypto";

/**
 * AES-256-GCM encryption for secrets at rest (e.g. per-user Anthropic API keys).
 * The key is derived from ENCRYPTION_KEY (preferred) or BETTER_AUTH_SECRET.
 * Server-only — never import into client components.
 */

/**
 * Version tag written in front of every ciphertext this module produces.
 * Payloads stored before the tag existed are plain `iv:tag:data` and are read
 * back with the legacy derivation below, so a deployment can adopt HKDF without
 * rewriting rows that are already in the database.
 */
const CURRENT_VERSION = "v1";

/**
 * A fixed application salt is the right call here: HKDF's salt provides domain
 * separation between uses of the same secret, not per-record uniqueness, and
 * these values must be reproducible to decrypt anything. Changing either string
 * makes every existing v1 payload unreadable.
 */
const KEY_SALT = Buffer.from("celluloid-secret-salt-v1", "utf8");
const KEY_INFO = Buffer.from("celluloid-secret-v1", "utf8");

function getSecret(): string {
  const secret = process.env.ENCRYPTION_KEY || process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("ENCRYPTION_KEY or BETTER_AUTH_SECRET must be set to encrypt secrets.");
  }
  return secret;
}

function getKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", getSecret(), KEY_SALT, KEY_INFO, 32));
}

/**
 * Derivation used before the version prefix: a single unsalted SHA-256 of the
 * secret, which offers no domain separation and no stretching. Read-only — it
 * exists so untagged rows already in the database still decrypt, and is never
 * used to write new ciphertext.
 */
function getLegacyKey(): Buffer {
  return crypto.createHash("sha256").update(getSecret()).digest(); // 32 bytes
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    CURRENT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string {
  const parts = payload.split(":");
  // Three segments means an untagged legacy payload; four means a versioned
  // one. The tag is what selects the derivation, so it has to be read before
  // any key is built — reaching for HKDF unconditionally would make every
  // pre-existing stored secret undecryptable.
  const versioned = parts.length === 4;
  if (!versioned && parts.length !== 3) throw new Error("Malformed ciphertext");
  if (versioned && parts[0] !== CURRENT_VERSION) {
    throw new Error("Unsupported ciphertext version");
  }
  const [ivB64, tagB64, dataB64] = versioned ? parts.slice(1) : parts;
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Malformed ciphertext");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    versioned ? getKey() : getLegacyKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
