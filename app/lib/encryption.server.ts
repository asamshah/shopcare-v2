/**
 * Application-level field encryption (AES-256-GCM).
 *
 * For secrets we store on behalf of a shop: customer signing keys, Klaviyo API
 * keys, outbound webhook secrets, and so on. It plays the role of Rails'
 * `encrypts :field`.
 *
 * Keys come from the environment as base64-encoded 32-byte values:
 *   APP_ENCRYPTION_KEY            the key new values are encrypted with
 *   APP_ENCRYPTION_PREVIOUS_KEYS  optional, comma-separated keys that can still
 *                                 decrypt, so you can rotate keys without breaking stored values
 *
 * Ciphertext format (one string, safe to store in a TEXT column):
 *   v1.<keyId>.<iv>.<authTag>.<ciphertext>   (base64url parts)
 * keyId is a short fingerprint of the key that encrypted the value, so
 * decryption picks the right key after a rotation.
 *
 * Pass `context` (for example "Shop.customerSigningKey") to bind a ciphertext
 * to the field it belongs to. It is used as GCM additional authenticated data,
 * so a value copied into another column fails to decrypt.
 *
 * Generate a key with: openssl rand -base64 32
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionError";
  }
}

interface Key {
  id: string;
  material: Buffer;
}

export interface KeyConfig {
  current: string;
  previous?: string[];
}

function parseKey(encoded: string): Key {
  const material = Buffer.from(encoded.trim(), "base64");
  if (material.length !== 32) {
    throw new EncryptionError(
      "Encryption keys must be 32 bytes, base64-encoded (openssl rand -base64 32).",
    );
  }
  const id = createHash("sha256").update(material).digest("hex").slice(0, 8);
  return { id, material };
}

function keysFromEnv(): KeyConfig {
  const current = process.env.APP_ENCRYPTION_KEY;
  if (!current) {
    throw new EncryptionError("APP_ENCRYPTION_KEY is not set.");
  }
  const previous = (process.env.APP_ENCRYPTION_PREVIOUS_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  return { current, previous };
}

/** Builds an encryptor. Uses the APP_ENCRYPTION_* env vars unless keys are passed. */
export function createEncryptor(config: KeyConfig = keysFromEnv()) {
  const current = parseKey(config.current);
  const byId = new Map<string, Key>([[current.id, current]]);
  for (const encoded of config.previous ?? []) {
    const key = parseKey(encoded);
    if (!byId.has(key.id)) byId.set(key.id, key);
  }

  function encrypt(plaintext: string, context = ""): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, current.material, iv);
    cipher.setAAD(Buffer.from(context, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      VERSION,
      current.id,
      iv.toString("base64url"),
      tag.toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
  }

  function decrypt(payload: string, context = ""): string {
    const parts = payload.split(".");
    if (parts.length !== 5 || parts[0] !== VERSION) {
      throw new EncryptionError("Not an encrypted value.");
    }
    const [, keyId, iv, tag, ciphertext] = parts;
    const key = byId.get(keyId);
    if (!key) {
      throw new EncryptionError(
        "Encrypted with an unknown key. Add it to APP_ENCRYPTION_PREVIOUS_KEYS.",
      );
    }
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        key.material,
        Buffer.from(iv, "base64url"),
      );
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64url")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new EncryptionError(
        "Could not decrypt: the value was tampered with or the context is wrong.",
      );
    }
  }

  /** True when the value was encrypted with an older key and should be re-saved. */
  function needsRotation(payload: string): boolean {
    return payload.split(".")[1] !== current.id;
  }

  return { encrypt, decrypt, needsRotation };
}

export type Encryptor = ReturnType<typeof createEncryptor>;

let defaultEncryptor: Encryptor | undefined;

function encryptor(): Encryptor {
  defaultEncryptor ??= createEncryptor();
  return defaultEncryptor;
}

export const encrypt = (plaintext: string, context?: string) =>
  encryptor().encrypt(plaintext, context);
export const decrypt = (payload: string, context?: string) =>
  encryptor().decrypt(payload, context);

/** Clears the cached env-based encryptor; for tests that change env vars. */
export function resetEncryptorForTests() {
  defaultEncryptor = undefined;
}
