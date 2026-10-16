/**
 * Which of a shop's records belong to one customer, for the GDPR webhooks
 * (customers/data_request, customers/redact). A record matches on the
 * Shopify customer id, the email address (case-insensitive), or (for items
 * and tickets) one of the order ids Shopify lists in the request. Port of
 * Repairs::CustomerRedactor#matching_* with order ids added.
 */
import { Prisma } from "@prisma/client";
import type { Db } from "../../lib/db-lock.server";
import { numericId } from "../../lib/gid";

export interface CustomerRef {
  customerId: string | null;
  email: string | null;
  /** orders_requested / orders_to_redact from the webhook. */
  orderIds: string[];
}

/** The `customer` (+ order ids) of a GDPR webhook body. */
export function customerRefFromWebhook(payload: unknown): CustomerRef {
  const body = (payload ?? {}) as Record<string, unknown>;
  const customer = (body.customer ?? {}) as Record<string, unknown>;
  const id =
    typeof customer.admin_graphql_api_id === "string"
      ? numericId(customer.admin_graphql_api_id)
      : customer.id == null || customer.id === ""
        ? null
        : String(customer.id);
  const email = typeof customer.email === "string" && customer.email.trim() ? customer.email.trim() : null;
  const orders = (body.orders_requested ?? body.orders_to_redact ?? []) as unknown[];
  return {
    customerId: id,
    email,
    orderIds: Array.isArray(orders) ? orders.map((o) => String(o)).filter((o) => /^\d+$/.test(o)) : [],
  };
}

type PersonWhere = {
  shopifyCustomerId?: string;
  customerEmail?: { equals: string; mode: "insensitive" };
};

function personClauses(ref: CustomerRef): PersonWhere[] {
  const clauses: PersonWhere[] = [];
  if (ref.customerId) clauses.push({ shopifyCustomerId: ref.customerId });
  if (ref.email) clauses.push({ customerEmail: { equals: ref.email, mode: "insensitive" } });
  return clauses;
}

const NONE = { id: { in: [] as number[] } };

export function ticketWhere(shopId: number, ref: CustomerRef): Prisma.RepairTicketWhereInput {
  const clauses: Prisma.RepairTicketWhereInput[] = [...personClauses(ref)];
  if (ref.orderIds.length) clauses.push({ item: { orderId: { in: ref.orderIds } } });
  return { shopId, ...(clauses.length ? { OR: clauses } : NONE) };
}

export function itemWhere(shopId: number, ref: CustomerRef): Prisma.ItemWhereInput {
  const clauses: Prisma.ItemWhereInput[] = [...personClauses(ref)];
  if (ref.orderIds.length) clauses.push({ orderId: { in: ref.orderIds } });
  return { shopId, ...(clauses.length ? { OR: clauses } : NONE) };
}

export function tradeInWhere(shopId: number, ref: CustomerRef): Prisma.TradeInWhereInput {
  const clauses: Prisma.TradeInWhereInput[] = [...personClauses(ref)];
  if (ref.orderIds.length) clauses.push({ shopifyOrderId: { in: ref.orderIds } });
  return { shopId, ...(clauses.length ? { OR: clauses } : NONE) };
}

/** Notification deliveries addressed to (or about) the customer. */
export async function matchingDeliveryIds(
  db: Db,
  shopId: number,
  ref: CustomerRef,
): Promise<number[]> {
  if (!ref.customerId && !ref.email) return [];
  const gid = ref.customerId ? `gid://shopify/Customer/${ref.customerId}` : null;
  const email = ref.email?.toLowerCase() ?? null;
  const rows = await db.$queryRaw<{ id: number }[]>`
    SELECT id FROM notification_deliveries
    WHERE shop_id = ${shopId} AND (
      (${ref.customerId}::text IS NOT NULL AND
        payload->'recipient'->>'customerId' IN (${ref.customerId}::text, ${gid}::text))
      OR (${email}::text IS NOT NULL AND (
        lower(payload->'recipient'->>'email') = ${email}::text OR
        lower(payload->'data'->>'customerEmail') = ${email}::text))
    )`;
  return rows.map((row) => row.id);
}
