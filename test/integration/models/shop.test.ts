// v2 checks for the Shop module (no Rails model test): encrypted secrets and
// settings defaults.
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import {
  careSettings,
  partsSettings,
  proxyUrl,
  quoteValidDays,
  setShopSecret,
  shopSecret,
  storeName,
  withRepairCollection,
} from "../../../app/models/shop.server";
import { createShop } from "../../support/factories";

describe("Shop", () => {
  it("stores secrets encrypted and bound to their column", async () => {
    const shop = await createShop();
    const saved = await setShopSecret(shop.id, "klaviyoApiKey", "pk_live_secret");

    expect(saved.klaviyoApiKeyCiphertext).not.toContain("pk_live_secret");
    expect(shopSecret(saved, "klaviyoApiKey")).toBe("pk_live_secret");
    // A ciphertext copied into another column doesn't decrypt.
    expect(() =>
      shopSecret({ ...saved, webhookSecretCiphertext: saved.klaviyoApiKeyCiphertext }, "webhookSecret"),
    ).toThrow();

    const cleared = await setShopSecret(shop.id, "klaviyoApiKey", "  ");
    expect(shopSecret(cleared, "klaviyoApiKey")).toBeNull();
  });

  it("fills settings defaults and reads the legacy sole model key", async () => {
    const shop = await createShop({
      shopifyDomain: "acme-boots.myshopify.com",
      settings: {
        care: { credit_days: "", refund_action: "credit" },
        parts: { sole_model_metafield: "custom.sole" },
        quote_valid_days: "0",
      },
    });

    expect(careSettings(shop)).toEqual({
      refund_action: "credit",
      credit_scope: "care",
      credit_days: "90",
      add_later_url: "",
    });
    expect(partsSettings(shop).model_metafield).toBe("custom.sole");
    expect(partsSettings(shop)).not.toHaveProperty("sole_model_metafield");
    expect(quoteValidDays(shop)).toBe(14);
    expect(proxyUrl(shop, "quotes/abc")).toBe("https://acme-boots.myshopify.com/apps/repairs/quotes/abc");
    expect(withRepairCollection(shop, "gid://shopify/Collection/42", " Repairs ").repair_products).toEqual({
      mode: "collection",
      collection_id: "42",
      collection_title: "Repairs",
    });
  });

  it("remembers the store name, falling back to the domain's handle", async () => {
    const shop = await createShop({ shopifyDomain: "acme-boots.myshopify.com" });

    expect(await storeName(shop, { shopName: async () => { throw new Error("down"); } })).toBe("Acme Boots");
    expect(await storeName(shop, { shopName: async () => "ACME Boots Ltd" })).toBe("ACME Boots Ltd");
    const reloaded = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(await storeName(reloaded, { shopName: async () => "Never asked" })).toBe("ACME Boots Ltd");
  });
});
