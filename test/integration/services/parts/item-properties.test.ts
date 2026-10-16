/** Port of Rails test/services/parts/item_properties_test.rb. */
import { describe, expect, it } from "vitest";
import prisma from "../../../../app/db.server";
import { partsSettings } from "../../../../app/models/shop.server";
import { itemProperties } from "../../../../app/services/parts/item-properties.server";
import { createItemFor, createShop } from "../../../support/factories";
import { FakeGraphql } from "../../../support/fake-graphql";

describe("itemProperties", () => {
  it("reads size, colour and model from Shopify once", async () => {
    const shop = await createShop({ settings: { parts: { model_metafield: "footwear.sole" } } });
    const item = await createItemFor(shop, { productTitle: "Boot", variantId: "100" });
    const api = new FakeGraphql({
      "productVariant(id:": {
        productVariant: {
          selectedOptions: [
            { name: "Size", value: "UK 8" },
            { name: "Colour", value: "Black" },
          ],
          product: { metafield: { value: "Commando" } },
        },
      },
    });

    const properties = await itemProperties(shop, api, item);
    await itemProperties(shop, api, await prisma.item.findUniqueOrThrow({ where: { id: item.id } }));

    expect([properties.size, properties.colour, properties.sole_model]).toEqual(["UK 8", "Black", "Commando"]);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].variables.withMetafield).toBe(true);
    const saved = await prisma.item.findUniqueOrThrow({ where: { id: item.id } });
    expect(saved.properties).toMatchObject({ size: "UK 8", fetched_at: expect.any(String) });
  });

  it("a failed read keeps what the item had and is tried again next time", async () => {
    const shop = await createShop();
    const item = await createItemFor(shop, { variantId: "100", properties: { note: "x" } });
    const api = new FakeGraphql({});
    const result = await itemProperties(shop, api, item, { logger: { error: () => {} } });
    expect(result).toEqual({ note: "x" });
    expect((await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).properties).toEqual({ note: "x" });
  });

  it("a shop saved before the rename still reads its sole model metafield", async () => {
    const shop = await createShop({ settings: { parts: { sole_model_metafield: "footwear.sole" } } });
    expect(partsSettings(shop).model_metafield).toBe("footwear.sole");
    expect(partsSettings(shop)).not.toHaveProperty("sole_model_metafield");
  });
});
