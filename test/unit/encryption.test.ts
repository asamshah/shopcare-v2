import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEncryptor,
  decrypt,
  encrypt,
  EncryptionError,
  resetEncryptorForTests,
} from "../../app/lib/encryption.server";

const key = () => randomBytes(32).toString("base64");

describe("encryption", () => {
  afterEach(() => resetEncryptorForTests());

  it("round-trips a value and never returns the plaintext", () => {
    const box = createEncryptor({ current: key() });
    const ciphertext = box.encrypt("shpss_signing_key");
    expect(ciphertext).not.toContain("shpss_signing_key");
    expect(ciphertext.startsWith("v1.")).toBe(true);
    expect(box.decrypt(ciphertext)).toBe("shpss_signing_key");
  });

  it("uses a fresh IV, so equal plaintexts give different ciphertexts", () => {
    const box = createEncryptor({ current: key() });
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });

  it("round-trips unicode and empty strings", () => {
    const box = createEncryptor({ current: key() });
    expect(box.decrypt(box.encrypt(""))).toBe("");
    expect(box.decrypt(box.encrypt("Café ☕ £15"))).toBe("Café ☕ £15");
  });

  it("rejects a tampered ciphertext", () => {
    const box = createEncryptor({ current: key() });
    const parts = box.encrypt("secret").split(".");
    const body = Buffer.from(parts[4], "base64url");
    body[0] ^= 1;
    parts[4] = body.toString("base64url");
    expect(() => box.decrypt(parts.join("."))).toThrow(EncryptionError);
  });

  it("binds a value to its context (field)", () => {
    const box = createEncryptor({ current: key() });
    const ciphertext = box.encrypt("secret", "Shop.customerSigningKey");
    expect(box.decrypt(ciphertext, "Shop.customerSigningKey")).toBe("secret");
    expect(() => box.decrypt(ciphertext, "Shop.klaviyoApiKey")).toThrow(
      EncryptionError,
    );
  });

  it("decrypts values from a previous key after rotation and flags them", () => {
    const oldKey = key();
    const newKey = key();
    const legacy = createEncryptor({ current: oldKey }).encrypt("secret");

    const rotated = createEncryptor({ current: newKey, previous: [oldKey] });
    expect(rotated.decrypt(legacy)).toBe("secret");
    expect(rotated.needsRotation(legacy)).toBe(true);
    expect(rotated.needsRotation(rotated.encrypt("secret"))).toBe(false);

    const forgotten = createEncryptor({ current: newKey });
    expect(() => forgotten.decrypt(legacy)).toThrow(/unknown key/);
  });

  it("refuses keys that aren't 32 bytes and values that aren't ciphertext", () => {
    expect(() => createEncryptor({ current: "c2hvcnQ=" })).toThrow(/32 bytes/);
    expect(() =>
      createEncryptor({ current: key() }).decrypt("plain text"),
    ).toThrow(EncryptionError);
  });

  it("reads APP_ENCRYPTION_KEY from the environment by default", () => {
    expect(decrypt(encrypt("from env", "ctx"), "ctx")).toBe("from env");
  });
});
