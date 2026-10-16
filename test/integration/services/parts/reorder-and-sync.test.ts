/** Port of Rails test/services/parts/reorder_and_sync_test.rb (ServiceSync → repairs/service-import). */
import { beforeEach, describe, expect, it } from "vitest";
import type { Shop } from "@prisma/client";
import prisma from "../../../../app/db.server";
import { moveStock } from "../../../../app/models/part-variant.server";
import { reorderCsv, reorderRows } from "../../../../app/services/parts/reorder-list.server";
import { importRepairServices } from "../../../../app/services/repairs/service-import.server";
import { buildWorkshop, createRepairServiceFor, createShop } from "../../../support/factories";

let shop: Shop;
let workshop: Awaited<ReturnType<typeof buildWorkshop>>;

beforeEach(async () => {
  shop = await createShop({ shopifyDomain: "reorder-test.myshopify.com" });
  workshop = await buildWorkshop(shop);
});

describe("ReorderList", () => {
  it("lists low variants with whole packs to order", async () => {
    const glue = await prisma.partVariant.findFirstOrThrow({ where: { partId: workshop.glue.id } });
    await moveStock(glue.id, 150, { reason: "received" });
    await prisma.part.update({ where: { id: workshop.glue.id }, data: { reorderQuantity: 600 } });
    for (const v of await prisma.partVariant.findMany({ where: { partId: workshop.sole.id } })) {
      await moveStock(v.id, 5, { reason: "received" });
    }

    const rows = await reorderRows(shop.id);

    expect(rows.map((r) => r.variant.id)).toEqual([glue.id]);
    // up to 200 + 600 = 800; have 150 → 650 ml → 2 packs of 500
    expect([rows[0].suggestedPacks, rows[0].suggestedUnits.toNumber()]).toEqual([2, 1000]);
    expect(await reorderCsv(shop.id)).toContain("Adhesive,Standard");
  });

  it("leaves out inactive parts and other shops' parts", async () => {
    await prisma.part.update({ where: { id: workshop.glue.id }, data: { active: false } });
    const other = await createShop();
    await buildWorkshop(other);
    expect((await reorderRows(shop.id)).every((r) => r.variant.part.shopId === shop.id && r.variant.part.active)).toBe(true);
    expect((await reorderRows(shop.id)).some((r) => r.variant.partId === workshop.glue.id)).toBe(false);
  });
});

describe("service import (Parts::ServiceSync)", () => {
  it("syncs services from the Shopify catalogue", async () => {
    const variant = (productId: string, productTitle: string, variantId: string, variantTitle: string, price: string) => ({
      productId,
      productTitle,
      variantId,
      variantTitle,
      price,
      label: variantTitle === "Default Title" ? productTitle : `${productTitle} — ${variantTitle}`,
    });
    const catalog = {
      configured: true,
      variants: async () => [
        variant("1", "Resole", "900", "Default Title", "65.00"),
        variant("2", "Heel", "901", "Rubber", "20.00"),
      ],
    };
    await createRepairServiceFor(shop, { title: "Old", shopifyVariantId: "800" });

    const counts = await importRepairServices(shop.id, catalog);

    expect(counts).toEqual({ added: 1, updated: 1, deactivated: 1 });
    const resole = await prisma.repairService.findUniqueOrThrow({ where: { id: workshop.service.id } });
    expect(resole.price.toNumber()).toBe(65);
    expect(await prisma.serviceComponent.count({ where: { repairServiceId: resole.id } })).toBe(2); // recipes survive
    expect((await prisma.repairService.findFirstOrThrow({ where: { shopId: shop.id, shopifyVariantId: "901" } })).title).toBe(
      "Heel — Rubber",
    );
  });

  it("does nothing when the catalogue isn't set up, and never touches another shop", async () => {
    expect(await importRepairServices(shop.id, { configured: false, variants: async () => [] })).toBeNull();
    const other = await createShop();
    const theirs = await createRepairServiceFor(other, { shopifyVariantId: "900" });
    await importRepairServices(shop.id, { configured: true, variants: async () => [] });
    expect((await prisma.repairService.findUniqueOrThrow({ where: { id: theirs.id } })).active).toBe(true);
  });
});
