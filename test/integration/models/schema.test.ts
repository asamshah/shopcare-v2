// v2 checks with no Rails test: the hand-written indexes, foreign key
// behaviour and the row-lock helper.
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { RecordNotFoundError, withRowLock } from "../../../app/lib/db-lock.server";
import { claimsCount, recordClaim } from "../../../app/models/cover.server";
import { moveStock } from "../../../app/models/part-variant.server";
import {
  buildWorkshop,
  createItemFor,
  createProductGroupFor,
  createRepairTicketFor,
  createShop,
  createTicketPartFor,
  createWarrantyCover,
  createWarrantyPolicyFor,
} from "../../support/factories";

const uniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

describe("schema", () => {
  it("allows one open trade-in per item, at the database level", async () => {
    const shop = await createShop();
    const item = await createItemFor(shop);
    const base = { shopId: shop.id, itemId: item.id, productTitle: "Boot" };
    await prisma.tradeIn.create({ data: { ...base, status: "requested" } });

    await expect(prisma.tradeIn.create({ data: { ...base, status: "approved" } })).rejects.toSatisfy(uniqueViolation);
    // Closed ones don't count.
    await prisma.tradeIn.create({ data: { ...base, status: "credited" } });
  });

  it("allows one item per order line unit, ignoring items without a line", async () => {
    const shop = await createShop();
    await createItemFor(shop, { orderLineId: "1", unitIndex: 0 });
    await createItemFor(shop, { orderLineId: null });
    await createItemFor(shop, { orderLineId: null });

    await expect(createItemFor(shop, { orderLineId: "1", unitIndex: 0 })).rejects.toSatisfy(uniqueViolation);
  });

  it("keeps product group names unique per shop regardless of case", async () => {
    const shop = await createShop();
    await prisma.productGroup.create({ data: { shopId: shop.id, name: "Leather" } });

    await expect(
      prisma.productGroup.create({ data: { shopId: shop.id, name: "LEATHER" } }),
    ).rejects.toSatisfy(uniqueViolation);
  });

  it("refuses to delete a product group or part in use, but a shop delete cascades through them", async () => {
    const shop = await createShop();
    const group = await createProductGroupFor(shop, { rule: "tags", tags: ["leather"] });
    await createWarrantyPolicyFor(shop, { productGroupId: group.id });
    const { sole } = await buildWorkshop(shop);
    const ticket = await createRepairTicketFor(shop);
    await createTicketPartFor(ticket.id, sole.id);
    await createWarrantyCover(shop);

    await expect(prisma.productGroup.delete({ where: { id: group.id } })).rejects.toThrow();
    await expect(prisma.part.delete({ where: { id: sole.id } })).rejects.toThrow();

    await prisma.shop.delete({ where: { id: shop.id } });
    expect(await prisma.part.count()).toBe(0);
    expect(await prisma.productGroup.count()).toBe(0);
    expect(await prisma.cover.count()).toBe(0);
  });

  it("nullifies optional links when the linked record goes", async () => {
    const shop = await createShop();
    const item = await createItemFor(shop);
    const ticket = await createRepairTicketFor(shop, { itemId: item.id });

    await prisma.item.delete({ where: { id: item.id } });
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).itemId).toBeNull();
  });
});

describe("withRowLock", () => {
  it("serialises concurrent read-modify-write updates", async () => {
    const shop = await createShop();
    const cover = await createWarrantyCover(shop);
    const { sole } = await buildWorkshop(shop);
    const variant = await prisma.partVariant.findFirstOrThrow({ where: { partId: sole.id } });

    await Promise.all([
      ...Array.from({ length: 5 }, () => recordClaim(cover.id)),
      ...Array.from({ length: 5 }, () => moveStock(variant.id, 2, { reason: "received" })),
    ]);

    expect(claimsCount(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(5);
    const reloaded = await prisma.partVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(Number(reloaded.onHand)).toBe(10);
  });

  it("rejects unknown rows and anything that isn't a table name", async () => {
    await expect(prisma.$transaction((tx) => withRowLock(tx, "covers", 999_999))).rejects.toThrow(
      RecordNotFoundError,
    );
    await expect(
      prisma.$transaction((tx) => withRowLock(tx, 'covers"; DROP TABLE shops; --', 1)),
    ).rejects.toThrow(/Not a table name/);
  });
});
