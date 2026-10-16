/**
 * Finds one order by its number for the storefront repair form ("Find the
 * product you bought"), without leaking anyone else's: a logged-in customer
 * only finds their own orders; a guest must also give the email on the order.
 * Any mismatch is indistinguishable from "no such order". Port of
 * Repairs::OrderLookup; the Shopify lookup and ownership check are
 * findOrderByNumber in app/shopify/orders.server.ts.
 *
 * The order's Items are recorded (idempotently, as the orders/paid webhook
 * would) so each line has its cover. Guests get a short-lived signed token
 * naming the order: the intake re-verifies it before linking a line, so the
 * browser never vouches for an order itself.
 */
import type { Cover, Item } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { derivedSecret, hmacHex, safeEqualHex } from "../../lib/signing.server";
import { COVERS_ORDER } from "../../models/item.server";
import { errorSummary, type AdminGraphqlClient } from "../../shopify/graphql.server";
import { findOrderByNumber, type OrderData } from "../../shopify/orders.server";
import type { ItemRecorder } from "../items/recorder.server";

export const ORDER_TOKEN_TTL_SECONDS = 2 * 60 * 60;

export interface OrderLookupResult {
  order: OrderData;
  /** One per order line (the first unit), each with its covers. */
  items: (Item & { covers: Cover[] })[];
  /** Line id → image URL. */
  images: Record<string, string>;
}

export async function lookUpOrder(
  shop: { id: number; shopifyDomain: string },
  client: AdminGraphqlClient,
  recorder: ItemRecorder,
  number: unknown,
  who: { customerId?: string | null; email?: string | null },
  { db = prisma, logger = console }: { db?: Db; logger?: Pick<Console, "error"> } = {},
): Promise<OrderLookupResult | null> {
  try {
    const order = await findOrderByNumber(client, number, who, logger);
    if (!order) return null;

    await recorder.record(order);
    const items = await db.item.findMany({
      where: { shopId: shop.id, status: "active", orderId: order.id },
      include: { covers: { orderBy: COVERS_ORDER } },
      orderBy: [{ orderLineId: "asc" }, { unitIndex: "asc" }],
    });
    if (items.length === 0) return null;

    const seen = new Set<string | null>();
    const perLine = items.filter((item) => {
      if (seen.has(item.orderLineId)) return false;
      seen.add(item.orderLineId);
      return true;
    });
    const images: Record<string, string> = {};
    for (const line of order.lines) if (line.imageUrl) images[line.id] = line.imageUrl;
    return { order, items: perLine, images };
  } catch (error) {
    logger.error(`[repairs/order-lookup] ${shop.shopifyDomain}: ${errorSummary(error)}`);
    return null;
  }
}

// --- Guest order token (Rails message_verifier, purpose "repair-intake") ------

const secret = () => derivedSecret("shopcare:order-lookup:repair-intake");

/** A token naming `orderId` for this shop, valid for two hours. */
export function orderToken(
  shop: { id: number },
  orderId: string,
  now: Date = new Date(),
): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: shop.id,
      o: String(orderId),
      e: Math.floor(now.getTime() / 1000) + ORDER_TOKEN_TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${hmacHex(secret(), payload)}`;
}

/** The order id a token names, if it's genuine, unexpired and for this shop. */
export function verifiedOrderId(
  shop: { id: number },
  token: unknown,
  now: Date = new Date(),
): string | null {
  if (typeof token !== "string") return null;
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqualHex(signature, hmacHex(secret(), payload))) return null;
  try {
    const { s, o, e } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      s?: unknown;
      o?: unknown;
      e?: unknown;
    };
    if (s !== shop.id || typeof o !== "string" || typeof e !== "number") return null;
    return Math.floor(now.getTime() / 1000) <= e ? o : null;
  } catch {
    return null;
  }
}
