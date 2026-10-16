// Port of Rails test/models/cover_test.rb.
import type { Item, Shop, WarrantyPolicy } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { addMonths } from "../../../app/lib/dates";
import {
  cancelCover,
  claimsCount,
  coverFree,
  coverInForce,
  coverName,
  coverOutcomeLabel,
  createCover,
  recordClaim,
  warrantyCoverFor,
} from "../../../app/models/cover.server";
import { activeCover, findItemWithCovers, updateItem } from "../../../app/models/item.server";
import { updateWarrantyPolicy } from "../../../app/models/warranty-policy.server";
import { createItemFor, createShop, createWarrantyPolicyFor } from "../../support/factories";

describe("Cover", () => {
  let shop: Shop;
  let item: Item;
  let policy: WarrantyPolicy;

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "cover-test.myshopify.com" });
    item = await createItemFor(shop, { productTitle: "Aria Boot", purchasedAt: addMonths(new Date(), -3) });
    policy = await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
  });

  it("warranty cover runs from purchase for the policy's months", async () => {
    const cover = await createCover(warrantyCoverFor(item, policy));

    expect(Math.abs(cover.endsAt.getTime() - addMonths(item.purchasedAt!, 12).getTime())).toBeLessThanOrEqual(1000);
    expect(coverInForce(cover)).toBe(true);
    expect(coverFree(cover)).toBe(true);
    expect(coverOutcomeLabel(cover)).toBe("Free repair");
  });

  it("editing the policy later doesn't change existing cover", async () => {
    const cover = await createCover(warrantyCoverFor(item, policy));
    await updateWarrantyPolicy(policy.id, { outcome: "discount", discountPercent: 10 });

    expect(coverFree(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(true);
  });

  it("the item's best cover in force wins", async () => {
    const half = await createWarrantyPolicyFor(shop, {
      name: "Half",
      months: 24,
      outcome: "discount",
      discountPercent: 50,
    });
    await createCover(warrantyCoverFor(item, half));
    await createCover(warrantyCoverFor(item, policy));

    expect(coverName(activeCover(await findItemWithCovers(item.id))!)).toBe("12-month warranty");
  });

  it("expired, cancelled, or refunded-item cover doesn't count", async () => {
    const old = await createItemFor(shop, { productTitle: "Old Boot", purchasedAt: addMonths(new Date(), -24) });
    await createCover(warrantyCoverFor(old, policy));
    expect(activeCover(await findItemWithCovers(old.id))).toBeNull();

    const cover = await createCover(warrantyCoverFor(item, policy));
    await updateItem(item.id, { status: "refunded" });
    expect(activeCover(await findItemWithCovers(item.id))).toBeNull();

    await updateItem(item.id, { status: "active" });
    await cancelCover(cover.id);
    expect(activeCover(await findItemWithCovers(item.id))).toBeNull();
  });

  it("claims are counted", async () => {
    const cover = await createCover(warrantyCoverFor(item, policy));
    await recordClaim(cover.id);
    await recordClaim(cover.id);

    expect(claimsCount(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(2);
  });
});
