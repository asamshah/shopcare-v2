/**
 * Refunds one line (a Care plan) on its original order, back to the original
 * payment, using Shopify's suggested refund transactions. Ported from Rails
 * `Care::PlanRefunder`; the caller passes the ids and the note.
 *
 * Multi-currency orders: when the customer paid in a currency other than the
 * shop's (presentment ≠ shop currency), the refund is made in the presentment
 * currency, which Shopify requires: `RefundInput.currency` is set and each
 * transaction's amount comes from `presentmentMoney`. Otherwise shop money.
 */
import { buildGid } from "../lib/gid";
import {
  adminGraphql,
  assertNoUserErrors,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const SUGGESTED_REFUND_QUERY = `#graphql
  query SuggestedRefund($id: ID!, $lines: [RefundLineItemInput!]) {
    order(id: $id) {
      currencyCode
      presentmentCurrencyCode
      suggestedRefund(refundLineItems: $lines) {
        suggestedTransactions {
          gateway
          amountSet {
            shopMoney { amount currencyCode }
            presentmentMoney { amount currencyCode }
          }
          parentTransaction { id }
        }
      }
    }
  }
`;

export const REFUND_CREATE_MUTATION = `#graphql
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund { id }
      userErrors { field message }
    }
  }
`;

export interface RefundLineOptions {
  /** Numeric id or GID. */
  orderId: string;
  /** Numeric id or GID. */
  lineItemId: string;
  quantity?: number;
  note: string;
  /** Email the customer. Default true. */
  notify?: boolean;
}

interface MoneyV2 {
  amount: string;
  currencyCode?: string;
}

interface SuggestedTransaction {
  gateway: string | null;
  amountSet: { shopMoney: MoneyV2; presentmentMoney?: MoneyV2 | null };
  parentTransaction: { id: string } | null;
}

/** Refunds the line without restocking. Returns the refund's GID. */
export async function refundLineItem(
  client: AdminGraphqlClient,
  options: RefundLineOptions,
): Promise<string> {
  const orderId = buildGid("Order", options.orderId);
  const lines = [
    {
      lineItemId: buildGid("LineItem", options.lineItemId),
      quantity: options.quantity ?? 1,
      restockType: "NO_RESTOCK",
    },
  ];
  const suggested = await adminGraphql<{
    order: {
      currencyCode?: string | null;
      presentmentCurrencyCode?: string | null;
      suggestedRefund: { suggestedTransactions: SuggestedTransaction[] } | null;
    } | null;
  }>(client, SUGGESTED_REFUND_QUERY, { id: orderId, lines });
  const order = suggested.order;
  if (!order) throw new Error(`Order ${options.orderId} not found`);

  const presentment =
    order.presentmentCurrencyCode &&
    order.currencyCode &&
    order.presentmentCurrencyCode !== order.currencyCode
      ? order.presentmentCurrencyCode
      : null;
  const transactions = (order.suggestedRefund?.suggestedTransactions ?? []).map(
    (t) => {
      const money = presentment ? t.amountSet.presentmentMoney : t.amountSet.shopMoney;
      if (!money)
        throw new Error(`Order ${options.orderId}: no ${presentment} amount to refund`);
      return {
        orderId,
        parentId: t.parentTransaction?.id,
        gateway: t.gateway,
        amount: money.amount,
        kind: "REFUND",
      };
    },
  );

  const data = await adminGraphql<{
    refundCreate: { refund: { id: string } | null; userErrors: UserError[] };
  }>(client, REFUND_CREATE_MUTATION, {
    input: {
      orderId,
      notify: options.notify ?? true,
      note: options.note,
      refundLineItems: lines,
      transactions,
      ...(presentment ? { currency: presentment } : {}),
    },
  });
  assertNoUserErrors("refundCreate", data.refundCreate);
  if (!data.refundCreate.refund)
    throw new Error("refundCreate returned no refund");
  return data.refundCreate.refund.id;
}
