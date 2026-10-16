// Port of Rails test/models/part_test.rb.
import type { Shop } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { ArgumentError, generateVariants, quantityLabel } from "../../../app/models/part.server";
import {
  createPartVariant,
  moveStock,
  variantLabel,
} from "../../../app/models/part-variant.server";
import { ValidationError } from "../../../app/models/validation.server";
import { buildWorkshop, createShop } from "../../support/factories";

describe("Part", () => {
  let shop: Shop;
  let workshop: Awaited<ReturnType<typeof buildWorkshop>>;

  const variantsOf = (partId: number) =>
    prisma.partVariant.findMany({ where: { partId }, orderBy: { id: "asc" } });

  beforeEach(async () => {
    shop = await createShop({ shopifyDomain: "parts-test.myshopify.com" });
    workshop = await buildWorkshop(shop);
  });

  it("generates one variant per combination, keeping existing ones", async () => {
    const { sole } = workshop;
    expect(await prisma.partVariant.count({ where: { partId: sole.id } })).toBe(4);

    const created = await generateVariants(sole.id, { model: ["Commando"], size: ["UK 8", "UK 9"] });

    expect(created).toBe(1);
    const labels = (await variantsOf(sole.id)).map((v) => variantLabel(v, sole));
    const known = ["Commando · UK 7", "Commando · UK 8", "Gumlite · UK 7", "Gumlite · UK 8"];
    expect(labels.filter((label) => !known.includes(label))).toEqual(["Commando · UK 9"]);
  });

  it("a part with no options gets a single standard variant", async () => {
    const { glue } = workshop;

    expect((await variantsOf(glue.id)).map((v) => variantLabel(v, glue))).toEqual(["Standard"]);
  });

  it("variants must set every option", async () => {
    await expect(
      createPartVariant({ partId: workshop.sole.id, options: { model: "Commando" } }),
    ).rejects.toThrow(ValidationError);
  });

  it("moving stock records a movement with the unit cost", async () => {
    const [variant] = await variantsOf(workshop.sole.id);
    await moveStock(variant.id, 5, { reason: "received", note: "Delivery" });
    await moveStock(variant.id, -1, { reason: "consumed" });

    const reloaded = await prisma.partVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(Number(reloaded.onHand)).toBe(4);
    const movements = await prisma.stockMovement.findMany({
      where: { partVariantId: variant.id },
      orderBy: { id: "asc" },
    });
    expect(movements.map((m) => Number(m.quantity))).toEqual([5, -1]);
    expect(Number(movements[0].unitCost)).toBe(12);
  });

  it("quantity labels use the part's unit", () => {
    expect(quantityLabel(workshop.sole, 2)).toBe("2 pairs");
    expect(quantityLabel(workshop.glue, 30)).toBe("30 ml");
  });

  it("refuses huge variant matrices", async () => {
    const range = Array.from({ length: 30 }, (_, i) => String(i + 1));

    await expect(generateVariants(workshop.sole.id, { model: range, size: range })).rejects.toThrow(
      ArgumentError,
    );
  });
});
