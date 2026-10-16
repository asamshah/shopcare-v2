/**
 * Orders from Shopify, reduced to what Item recording, order lookup and
 * purchase history need:
 *
 * - orderFromGraphql / orderFromWebhook (Rails `Items::OrderData`): one
 *   `OrderData` shape from a GraphQL Order node or the REST-shaped
 *   `orders/paid` webhook body, so the webhook and the backfill share one recorder.
 * - fetchOrder, fetchRecentPaidOrders (Rails `Items::OrderImporter`): one
 *   order on demand, or every paid order since a date (the post-install backfill).
 * - findOrderByNumber (Rails `Repairs::OrderLookup#find`): an order by its
 *   number, only for its own customer, or a guest who gives its email.
 * - fetchPurchaseHistory (Rails `Repairs::PurchaseHistory`): the variants a
 *   logged-in customer bought, most recent order first.
 *
 * Recording Items stays with the caller.
 */
import { buildGid, numericId, numericIdOrNull } from "../lib/gid";
import {
  adminGraphql,
  errorSummary,
  type AdminGraphqlClient,
} from "./graphql.server";

export const ORDER_FIELDS = `
  id name processedAt createdAt email tags
  customer { id displayName defaultEmailAddress { emailAddress } }
  lineItems(first: 100) { nodes {
    id title variantTitle sku quantity requiresShipping isGiftCard
    customAttributes { key value }
    discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount } }
    image { url }
    product { id } variant { id }
  } }
`;

export const ORDER_QUERY = `#graphql
  query OrderForItems($id: ID!) {
    order(id: $id) { ${ORDER_FIELDS} }
  }
`;

export const ORDERS_QUERY = `#graphql
  query OrdersForItems($first: Int!, $after: String, $q: String!) {
    orders(first: $first, after: $after, query: $q, sortKey: PROCESSED_AT) {
      nodes { ${ORDER_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_BY_NAME_QUERY = `#graphql
  query OrderByName($q: String!) {
    orders(first: 5, query: $q) {
      nodes { ${ORDER_FIELDS} }
    }
  }
`;

export const PURCHASE_HISTORY_QUERY = `#graphql
  query PurchaseHistory($id: ID!) {
    customer(id: $id) {
      orders(first: 30, sortKey: PROCESSED_AT, reverse: true) {
        nodes {
          id name processedAt
          lineItems(first: 25) { nodes {
            id
            image { url }
            variant {
              id title
              media(first: 1) { nodes { preview { image { url } } } }
              product { id title featuredMedia { preview { image { url } } } }
            }
          } }
        }
      }
    }
  }
`;

export interface OrderLine {
  id: string;
  productId: string | null;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  requiresShipping: boolean;
  giftCard: boolean;
  /** What the customer paid per unit after discounts, as a decimal string. */
  unitPrice: string | null;
  properties: Record<string, string>;
  /** Line image (GraphQL orders only). */
  imageUrl: string | null;
}

export interface OrderData {
  id: string;
  name: string;
  processedAt: Date | null;
  customerId: string | null;
  email: string | null;
  customerName: string | null;
  /** Lower-cased. */
  tags: string[];
  lines: OrderLine[];
}

export interface OrderNode {
  id: string;
  name: string;
  processedAt: string | null;
  createdAt: string | null;
  email: string | null;
  tags: string[];
  customer: {
    id: string;
    displayName: string | null;
    defaultEmailAddress: { emailAddress: string | null } | null;
  } | null;
  lineItems: {
    nodes: {
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      requiresShipping: boolean;
      isGiftCard: boolean;
      customAttributes: { key: string; value: string | null }[];
      discountedUnitPriceAfterAllDiscountsSet: {
        shopMoney: { amount: string };
      } | null;
      image: { url: string } | null;
      product: { id: string } | null;
      variant: { id: string } | null;
    }[];
  };
}

export function orderFromGraphql(node: OrderNode): OrderData {
  const customer = node.customer;
  return {
    id: numericId(node.id),
    name: node.name,
    processedAt: parseTime(node.processedAt ?? node.createdAt),
    customerId: numericIdOrNull(customer?.id),
    email:
      presence(node.email) ??
      presence(customer?.defaultEmailAddress?.emailAddress),
    customerName: presence(customer?.displayName),
    tags: (node.tags ?? []).map((t) => t.trim().toLowerCase()),
    lines: (node.lineItems?.nodes ?? []).map((line) => ({
      id: numericId(line.id),
      productId: numericIdOrNull(line.product?.id),
      variantId: numericIdOrNull(line.variant?.id),
      title: line.title,
      variantTitle: line.variantTitle ?? null,
      sku: presence(line.sku),
      quantity: Math.trunc(Number(line.quantity) || 0),
      requiresShipping: line.requiresShipping !== false,
      giftCard: line.isGiftCard === true,
      unitPrice:
        line.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ?? null,
      properties: Object.fromEntries(
        (line.customAttributes ?? []).map((a) => [
          String(a.key),
          String(a.value ?? ""),
        ]),
      ),
      imageUrl: line.image?.url ?? null,
    })),
  };
}

/**
 * The REST-shaped body of an orders/paid (or orders/*) webhook. JSON.parse
 * turns its numeric `id`s into JS numbers, which can't hold every 64-bit id
 * exactly, so ids are read from `admin_graphql_api_id` (a GID string) when
 * the payload has it, and the number only as a fallback.
 */
export interface OrderWebhookBody {
  id: number | string;
  admin_graphql_api_id?: string | null;
  name?: string;
  processed_at?: string | null;
  created_at?: string | null;
  email?: string | null;
  tags?: string | null;
  customer?: {
    id?: number | string | null;
    admin_graphql_api_id?: string | null;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
  line_items?: {
    id: number | string;
    admin_graphql_api_id?: string | null;
    product_id?: number | string | null;
    variant_id?: number | string | null;
    title?: string;
    variant_title?: string | null;
    sku?: string | null;
    quantity?: number;
    requires_shipping?: boolean;
    gift_card?: boolean;
    price?: string | number;
    total_discount?: string | number;
    properties?: { name: string; value: unknown }[];
  }[];
}

/** A webhook object's id as a string: from its GID when present. */
function webhookId(object: {
  id?: number | string | null;
  admin_graphql_api_id?: string | null;
}): string | null {
  if (object.admin_graphql_api_id) return numericId(object.admin_graphql_api_id);
  return object.id == null || object.id === "" ? null : String(object.id);
}

export function orderFromWebhook(body: OrderWebhookBody): OrderData {
  const customer = body.customer ?? {};
  return {
    id: webhookId(body) ?? "",
    name: body.name ?? "",
    processedAt: parseTime(body.processed_at ?? body.created_at ?? null),
    customerId: webhookId(customer),
    email: presence(body.email) ?? presence(customer.email),
    customerName: presence(
      [customer.first_name, customer.last_name]
        .filter((p) => p && p.trim())
        .join(" "),
    ),
    tags: (body.tags ?? "")
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
    lines: (body.line_items ?? []).map((line) => ({
      id: webhookId(line) ?? "",
      productId: line.product_id == null ? null : String(line.product_id),
      variantId: line.variant_id == null ? null : String(line.variant_id),
      title: line.title ?? "",
      variantTitle: line.variant_title ?? null,
      sku: presence(line.sku),
      quantity: Math.trunc(Number(line.quantity) || 0),
      requiresShipping: line.requires_shipping !== false,
      giftCard: line.gift_card === true,
      unitPrice: webhookUnitPrice(
        line.price,
        line.total_discount,
        line.quantity,
      ),
      properties: Object.fromEntries(
        (line.properties ?? []).map((p) => [
          String(p.name),
          String(p.value ?? ""),
        ]),
      ),
      imageUrl: null,
    })),
  };
}

/** Price less the line's discount per unit, to the cent. */
function webhookUnitPrice(
  price: string | number | undefined,
  totalDiscount: string | number | undefined,
  quantity: number | undefined,
): string {
  const units = Math.max(Math.trunc(Number(quantity) || 0), 1);
  const priceCents = Math.round(Number(price ?? 0) * 100);
  const discountCents = Math.round(Number(totalDiscount ?? 0) * 100);
  return ((priceCents - discountCents / units) / 100).toFixed(2);
}

/** One order (numeric id or GID), or null if Shopify doesn't know it. */
export async function fetchOrder(
  client: AdminGraphqlClient,
  orderId: string,
): Promise<OrderData | null> {
  const data = await adminGraphql<{ order: OrderNode | null }>(
    client,
    ORDER_QUERY,
    { id: buildGid("Order", orderId) },
  );
  return data.order ? orderFromGraphql(data.order) : null;
}

/**
 * The order, but only if it belongs to `customerId`: callers pass a
 * storefront customer, who must not be able to claim someone else's order.
 */
export async function fetchCustomerOrder(
  client: AdminGraphqlClient,
  orderId: string,
  customerId: string | null | undefined,
): Promise<OrderData | null> {
  if (!customerId) return null;
  const order = await fetchOrder(client, orderId);
  return order && order.customerId === String(customerId) ? order : null;
}

export const RECENT_ORDERS_PAGE_SIZE = 50;
export const RECENT_ORDERS_MAX_PAGES = 200; // 10k orders; a safety stop

/** The search for paid orders processed since a date. */
export function recentPaidOrdersQuery(since: Date): string {
  const day = since.toISOString().slice(0, 10);
  return `processed_at:>=${day} AND (financial_status:paid OR financial_status:partially_refunded)`;
}

export interface PaidOrdersPage {
  orders: OrderData[];
  /** Pass as `after` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** One page of paid (or partly refunded) orders processed since `since`. */
export async function fetchPaidOrdersPage(
  client: AdminGraphqlClient,
  since: Date,
  after: string | null = null,
): Promise<PaidOrdersPage> {
  const data: {
    orders: {
      nodes: OrderNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } = await adminGraphql(client, ORDERS_QUERY, {
    first: RECENT_ORDERS_PAGE_SIZE,
    after,
    q: recentPaidOrdersQuery(since),
  });
  return {
    orders: (data.orders.nodes ?? []).map(orderFromGraphql),
    nextCursor: data.orders.pageInfo.hasNextPage
      ? data.orders.pageInfo.endCursor
      : null,
  };
}

/**
 * Every paid (or partly refunded) order processed since `since`, one page at
 * a time. Errors propagate so the job can retry.
 */
export async function* fetchRecentPaidOrders(
  client: AdminGraphqlClient,
  since: Date,
): AsyncGenerator<OrderData[]> {
  let after: string | null = null;
  for (let page = 0; page < RECENT_ORDERS_MAX_PAGES; page++) {
    const result: PaidOrdersPage = await fetchPaidOrdersPage(client, since, after);
    yield result.orders;
    if (!result.nextCursor) return;
    after = result.nextCursor;
  }
}

const ORDER_NAME_FORMAT = /^[A-Z0-9][A-Z0-9-]{0,29}$/;

/** "#1042", " 1042 " → "1042"; null if it can't be an order number. */
export function normaliseOrderNumber(number: unknown): string | null {
  const name = String(number ?? "")
    .trim()
    .replace(/^#/, "")
    .trim()
    .toUpperCase();
  return ORDER_NAME_FORMAT.test(name) ? name : null;
}

/**
 * Finds an order by its number for the storefront repair form, without
 * leaking anyone else's: a logged-in customer only finds their own orders; a
 * guest must also give the email on the order. Any mismatch looks like "no
 * such order" (null). Errors are logged and give null.
 */
export async function findOrderByNumber(
  client: AdminGraphqlClient,
  number: unknown,
  who: { customerId?: string | null; email?: string | null },
  logger: Pick<Console, "error"> = console,
): Promise<OrderData | null> {
  const name = normaliseOrderNumber(number);
  const email = who.email?.trim() ?? "";
  if (!name || (!who.customerId && !email)) return null;
  try {
    const data = await adminGraphql<{ orders: { nodes: OrderNode[] } }>(
      client,
      ORDER_BY_NAME_QUERY,
      { q: `name:${name}` },
    );
    const node = (data.orders?.nodes ?? []).find(
      (candidate) => normaliseOrderNumber(candidate.name) === name,
    );
    if (!node) return null;
    const order = orderFromGraphql(node);
    return belongs(order, who.customerId, email) ? order : null;
  } catch (error) {
    logger.error(
      `[shopify/orders] order lookup failed: ${errorSummary(error)}`,
    );
    return null;
  }
}

function belongs(
  order: OrderData,
  customerId: string | null | undefined,
  email: string,
): boolean {
  if (customerId)
    return order.customerId !== null && order.customerId === String(customerId);
  return (
    order.email !== null &&
    order.email.trim().toLowerCase() === email.toLowerCase()
  );
}

export interface PurchasedItem {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  imageUrl: string | null;
  orderName: string;
  orderDate: string | null;
  orderId: string;
  orderLineId: string;
}

interface MediaNode {
  preview: { image: { url: string } | null } | null;
}

interface PurchaseHistoryOrder {
  id: string;
  name: string;
  processedAt: string | null;
  lineItems: {
    nodes: {
      id: string;
      image: { url: string } | null;
      variant: {
        id: string;
        title: string;
        media: { nodes: MediaNode[] } | null;
        product: {
          id: string;
          title: string;
          featuredMedia: MediaNode | null;
        } | null;
      } | null;
    }[];
  };
}

/**
 * The products a logged-in customer bought (their last 30 orders), one per
 * variant, keeping the most recent order. Never throws: errors give [].
 */
export async function fetchPurchaseHistory(
  client: AdminGraphqlClient,
  customerId: string | null | undefined,
  logger: Pick<Console, "error"> = console,
): Promise<PurchasedItem[]> {
  if (!customerId) return [];
  try {
    const data = await adminGraphql<{
      customer: { orders: { nodes: PurchaseHistoryOrder[] } } | null;
    }>(client, PURCHASE_HISTORY_QUERY, {
      id: buildGid("Customer", customerId),
    });
    const seen = new Set<string>();
    const items: PurchasedItem[] = [];
    for (const order of data.customer?.orders?.nodes ?? []) {
      for (const line of order.lineItems?.nodes ?? []) {
        const variant = line.variant;
        const product = variant?.product;
        if (!variant || !product) continue; // deleted product
        const variantId = numericId(variant.id);
        if (seen.has(variantId)) continue; // orders are newest first
        seen.add(variantId);
        items.push({
          productId: numericId(product.id),
          variantId,
          productTitle: product.title,
          variantTitle: variant.title,
          imageUrl:
            variant.media?.nodes?.[0]?.preview?.image?.url ??
            line.image?.url ??
            product.featuredMedia?.preview?.image?.url ??
            null,
          orderName: order.name,
          orderDate: order.processedAt,
          orderId: numericId(order.id),
          orderLineId: numericId(line.id),
        });
      }
    }
    return items;
  } catch (error) {
    logger.error(
      `[shopify/orders] purchase history failed: ${errorSummary(error)}`,
    );
    return [];
  }
}

function presence(value: string | null | undefined): string | null {
  return value && value.trim() !== "" ? value : null;
}

function parseTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
