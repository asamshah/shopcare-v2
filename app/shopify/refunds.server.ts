/**
 * Refunds one line (a Care plan) on its original order, back to the original
 * payment, using Shopify's suggested refund transactions. Ported from Rails
 * `Care::PlanRefunder`; the caller passes the ids and the note.
 */
import { buildGid } from "./gid.server";
import {
  adminGraphql,
  assertNoUserErrors,
  type AdminGraphqlClient,
  type UserError,
} from "./graphql.server";

export const SUGGESTED_REFUND_QUERY = `#graphql
  query SuggestedRefund($id: ID!, $lines: [RefundLineItemInput!]) {
    order(id: $id) {
      suggestedRefund(refundLineItems: $lines) {
        suggestedTransactions {
          gateway
          amountSet { shopMoney { amount } }
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

interface SuggestedTransaction {
  gateway: string | null;
  amountSet: { shopMoney: { amount: string } };
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
      suggestedRefund: { suggestedTransactions: SuggestedTransaction[] } | null;
    } | null;
  }>(client, SUGGESTED_REFUND_QUERY, { id: orderId, lines });
  if (!suggested.order) throw new Error(`Order ${options.orderId} not found`);

  const transactions = (
    suggested.order.suggestedRefund?.suggestedTransactions ?? []
  ).map((t) => ({
    orderId,
    parentId: t.parentTransaction?.id,
    gateway: t.gateway,
    amount: t.amountSet.shopMoney.amount,
    kind: "REFUND",
  }));

  const data = await adminGraphql<{
    refundCreate: { refund: { id: string } | null; userErrors: UserError[] };
  }>(client, REFUND_CREATE_MUTATION, {
    input: {
      orderId,
      notify: options.notify ?? true,
      note: options.note,
      refundLineItems: lines,
      transactions,
    },
  });
  assertNoUserErrors("refundCreate", data.refundCreate);
  if (!data.refundCreate.refund)
    throw new Error("refundCreate returned no refund");
  return data.refundCreate.refund.id;
}
