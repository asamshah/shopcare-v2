/**
 * Creates a single-use Shopify discount code worth what the customer paid
 * for a Care plan whose item was refunded. By default it only applies to Care
 * products (move Care to another product, or upgrade); merchants can let it
 * apply to anything (Settings → Care plans → credit scope "store"). Port of
 * Care::CreditIssuer.
 *
 * One credit per cover: an existing one is returned rather than issued again.
 */
import { Prisma, type CareCredit, type Cover, type Item, type Shop } from "@prisma/client";
import prisma from "../../db.server";
import { addDays } from "../../lib/dates";
import type { Db } from "../../lib/db-lock.server";
import { createCareCredit } from "../../models/care-credit.server";
import { coverName } from "../../models/cover.server";
import { itemLabel } from "../../models/item.server";
import { careSettings } from "../../models/shop.server";
import { jsonObject } from "../../models/validation.server";
import {
  createDiscountCode,
  generateDiscountCode,
} from "../../shopify/discount-codes.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";

export async function issueCareCredit(
  shop: Pick<Shop, "id" | "settings">,
  client: AdminGraphqlClient,
  cover: Cover & { item: Item },
  { db = prisma, now = new Date() }: { db?: Db; now?: Date } = {},
): Promise<CareCredit> {
  const existing = await db.careCredit.findUnique({ where: { coverId: cover.id } });
  if (existing) return existing;

  const amount = new Prisma.Decimal(
    String(cover.pricePaid ?? jsonObject(cover.terms).price ?? 0),
  );
  if (!amount.gt(0)) throw new Error("Nothing to credit: no price recorded for this Care plan");

  const code = generateDiscountCode("CARE");
  const days = parseInt(String(careSettings(shop).credit_days ?? ""), 10);
  const expiresAt = days > 0 ? addDays(now, days) : null;
  const discountId = await createDiscountCode(client, {
    title: `ShopCare credit: ${coverName(cover)} (${itemLabel(cover.item)})`,
    code,
    amount: amount.toFixed(2),
    customerId: cover.item.shopifyCustomerId,
    productIds: await productIds(shop, db),
    expiresAt,
  });
  return createCareCredit(
    { shopId: shop.id, coverId: cover.id, code, amount, expiresAt, shopifyDiscountId: discountId },
    db,
  );
}

/** Care products only, unless the merchant lets the credit go on anything. */
async function productIds(shop: Pick<Shop, "id" | "settings">, db: Db) {
  if (careSettings(shop).credit_scope === "store") return null;
  const plans = await db.carePlan.findMany({
    where: { shopId: shop.id, shopifyProductId: { not: null } },
    select: { shopifyProductId: true },
  });
  const ids = [...new Set(plans.map((p) => p.shopifyProductId!))];
  return ids.length ? ids : null;
}
