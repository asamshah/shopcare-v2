/** Ported from Rails test/services/shopify/customer_signing_key_test.rb. */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureCustomerSigningKey,
  rotateCustomerSigningKey,
  type SigningKeyState,
} from "../../../app/shopify/customer-signing-key.server";
import { FakeGraphql } from "../../support/fake-graphql";

const installation = {
  currentAppInstallation: { id: "gid://shopify/AppInstallation/9" },
};

function fakeApi(userErrors: { message: string }[] = []) {
  return new FakeGraphql({
    currentAppInstallation: installation,
    metafieldsSet: { metafieldsSet: { metafields: [], userErrors } },
  });
}

describe("customer signing key", () => {
  // Stands in for the Shop row: what `save` persisted last.
  let stored: SigningKeyState;
  const save = async (state: SigningKeyState) => {
    stored = { ...state };
  };
  let api: FakeGraphql;

  beforeEach(() => {
    stored = { key: null, publishedAt: null };
    api = fakeApi();
  });

  const publishedValue = (fake = api) =>
    (
      fake.calls.filter((c) => c.query.includes("metafieldsSet")).at(-1)
        ?.variables.metafields as Record<string, string>[] | undefined
    )?.[0];

  it("ensure creates a key and publishes it as an app-data metafield", async () => {
    await ensureCustomerSigningKey(api, stored, save);

    expect(stored.key).toMatch(/^[0-9a-f]{64}$/);
    expect(publishedValue()).toEqual({
      ownerId: "gid://shopify/AppInstallation/9",
      namespace: "shopcare",
      key: "customer_signing_key",
      type: "single_line_text_field",
      value: stored.key,
    });
    expect(stored.publishedAt).toBeTruthy();
  });

  it("ensure does nothing once the key is published", async () => {
    await ensureCustomerSigningKey(api, stored, save);
    const key = stored.key;

    await ensureCustomerSigningKey(api, stored, save);

    expect(stored.key).toBe(key);
    expect(api.calls).toHaveLength(2);
  });

  it("ensure republishes a key that never reached Shopify", async () => {
    const failing = fakeApi([{ message: "nope" }]);
    await expect(
      ensureCustomerSigningKey(failing, stored, save),
    ).rejects.toThrow("nope");
    const key = stored.key;
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.publishedAt).toBeNull();

    await ensureCustomerSigningKey(api, stored, save);

    expect(stored.key).toBe(key);
    expect(publishedValue()?.value).toBe(key);
  });

  it("rotate replaces the key", async () => {
    await ensureCustomerSigningKey(api, stored, save);
    const old = stored.key;

    await rotateCustomerSigningKey(api, save);

    expect(stored.key).not.toBe(old);
    expect(publishedValue()?.value).toBe(stored.key);
  });
});
