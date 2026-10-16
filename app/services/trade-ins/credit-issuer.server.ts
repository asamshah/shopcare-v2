/**
 * Pays out a trade-in's credit, as the merchant chose in Settings → Trade-in:
 *   store_credit  Shopify store credit on the customer's account (needs a
 *                 known customer; otherwise falls back to a code)
 *   discount_code a single-use code for the amount
 * Returns { method, reference }. Port of TradeIns::CreditIssuer; the Shopify
 * calls are creditStoreCredit and createDiscountCode in app/shopify/.
 */
import type { Shop, TradeIn } from "@prisma/client";
import { addDays } from "../../lib/dates";
import { tradeInSettings } from "../../models/shop.server";
import { tradeInCredit } from "../../models/trade-in.server";
import {
  createDiscountCode,
  generateDiscountCode,
} from "../../shopify/discount-codes.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { creditStoreCredit } from "../../shopify/store-credit.server";

export type CreditMethod = "store_credit" | "discount_code";

export async function issueTradeInCredit(
  shop: Pick<Shop, "settings">,
  client: AdminGraphqlClient,
  tradeIn: Pick<
    TradeIn,
    "finalCredit" | "quotedCredit" | "currency" | "shopifyCustomerId" | "productTitle"
  >,
  {
    shopCurrency,
    now = new Date(),
  }: {
    /** Used when the trade-in has no currency recorded. */
    shopCurrency: string;
    now?: Date;
  },
): Promise<{ method: CreditMethod; reference: string }> {
  const amount = tradeInCredit(tradeIn);
  if (!amount.gt(0)) throw new Error("Nothing to credit");

  const settings = tradeInSettings(shop);
  const days = parseInt(String(settings.credit_days ?? ""), 10);
  const expiresAt = days > 0 ? addDays(now, days) : null;

  if (settings.credit_method === "store_credit" && tradeIn.shopifyCustomerId) {
    const reference = await creditStoreCredit(client, {
      customerId: tradeIn.shopifyCustomerId,
      amount: amount.toFixed(2),
      currencyCode: tradeIn.currency || shopCurrency,
      expiresAt,
    });
    return { method: "store_credit", reference };
  }

  const code = generateDiscountCode("TRADEIN");
  await createDiscountCode(client, {
    title: `ShopCare trade-in credit: ${tradeIn.productTitle}`,
    code,
    amount: amount.toFixed(2),
    customerId: tradeIn.shopifyCustomerId,
    expiresAt,
  });
  return { method: "discount_code", reference: code };
}
