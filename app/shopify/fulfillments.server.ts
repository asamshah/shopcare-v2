/**
 * Fulfilling a repair order, so Shopify emails the customer its Shipping
 * confirmation (with the tracking link) when the repaired item is posted back.
 *
 *   order.fulfillmentOrders  the order's fulfillment orders that can still be
 *                            fulfilled (supportedActions has CREATE_FULFILLMENT)
 *   fulfillmentCreate        one fulfillment for all of them, with tracking and
 *                            notifyCustomer: true ("a notification is sent when
 *                            the fulfillment is created"; default false)
 *
 * Scopes: reading fulfillment orders needs read_merchant_managed_fulfillment_orders,
 * fulfillmentCreate needs write_merchant_managed_fulfillment_orders (repair
 * orders are fulfilled from the merchant's own location).
 * https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
 * https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrder
 */
import { buildGid, numericId } from "../lib/gid";
import { adminGraphql, assertNoUserErrors, type AdminGraphqlClient, type UserError } from "./graphql.server";

export const ORDER_FULFILLMENT_ORDERS_QUERY = `#graphql
  query RepairOrderFulfillmentOrders($id: ID!) {
    order(id: $id) {
      id
      name
      fulfillmentOrders(first: 20) {
        nodes { id status supportedActions { action } }
      }
    }
  }
`;

export const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation RepairFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo { company number url } }
      userErrors { field message }
    }
  }
`;

export interface Tracking {
  company?: string | null;
  number?: string | null;
  url?: string | null;
}

export class NothingToFulfilError extends Error {
  constructor(orderName: string) {
    super(`Order ${orderName} has nothing left to fulfil in Shopify.`);
    this.name = "NothingToFulfilError";
  }
}

interface OrderNode {
  order: {
    id: string;
    name: string;
    fulfillmentOrders: { nodes: { id: string; status: string; supportedActions: { action: string }[] }[] };
  } | null;
}

/**
 * Fulfils everything still open on the order, with tracking, and has Shopify
 * notify the customer. Returns the fulfillment id (numeric).
 */
export async function fulfilOrderWithTracking(
  client: AdminGraphqlClient,
  orderId: string,
  tracking: Tracking,
  { notifyCustomer = true }: { notifyCustomer?: boolean } = {},
): Promise<{ fulfillmentId: string; orderName: string }> {
  const data = await adminGraphql<OrderNode>(client, ORDER_FULFILLMENT_ORDERS_QUERY, {
    id: buildGid("Order", orderId),
  });
  if (!data.order) throw new Error(`Shopify order ${orderId} not found.`);
  const open = data.order.fulfillmentOrders.nodes.filter((fo) =>
    fo.supportedActions.some((a) => a.action === "CREATE_FULFILLMENT"),
  );
  if (open.length === 0) throw new NothingToFulfilError(data.order.name);

  const trackingInfo = Object.fromEntries(
    Object.entries({ company: tracking.company, number: tracking.number, url: tracking.url })
      .map(([k, v]) => [k, v?.trim()])
      .filter(([, v]) => v),
  );
  const result = await adminGraphql<{
    fulfillmentCreate: { fulfillment: { id: string } | null; userErrors: UserError[] };
  }>(client, FULFILLMENT_CREATE_MUTATION, {
    fulfillment: {
      lineItemsByFulfillmentOrder: open.map((fo) => ({ fulfillmentOrderId: fo.id })),
      notifyCustomer,
      ...(Object.keys(trackingInfo).length ? { trackingInfo } : {}),
    },
  });
  assertNoUserErrors("fulfillmentCreate", result.fulfillmentCreate);
  return { fulfillmentId: numericId(result.fulfillmentCreate.fulfillment!.id), orderName: data.order.name };
}
