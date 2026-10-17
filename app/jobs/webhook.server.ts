import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import type { FileStorage } from "../lib/storage.server";
import { adminAppUrl, tradeInEnabled } from "../models/shop.server";
import { notify } from "../services/notifications/notify.server";
import { removeCareOfferTag } from "../services/care/care-offer-tags.server";
import { notifyCareActivated } from "../services/care/notices.server";
import { customerRefFromWebhook } from "../services/gdpr/customer-match.server";
import { exportCustomerData } from "../services/gdpr/customer-export.server";
import { redactCustomer } from "../services/gdpr/customer-redactor.server";
import { redactShop } from "../services/gdpr/shop-redact.server";
import { ItemRecorder } from "../services/items/recorder.server";
import {
  processRefund,
  type RefundWebhookBody,
} from "../services/items/refund-processor.server";
import type { NotificationDeps } from "../services/notifications.server";
import {
  isRepairOrder,
  processRepairPayment,
  type PaidOrderBody,
} from "../services/payments/repair-payment.server";
import { linkTradeInsToOrder } from "../services/trade-ins/order-linker.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";
import { orderFromWebhook, type OrderWebhookBody } from "../shopify/orders.server";
import { ProductFactsLoader } from "../shopify/product-facts.server";
import { fetchShopInfo } from "../shopify/shop.server";
import type { JobPayload } from "./registry.server";

/**
 * Slow work for a Shopify webhook, after the route has acked it (Rails
 * ShopWebhookJob subclasses; see docs/BACKGROUND-WORK.md). The route checks
 * the HMAC and enqueues `{ topic, shop, payload, webhookId }` (saved as a
 * `jobs` row); this runs the topic's handler with the shop's row. A shop that
 * no longer exists is a no-op, so Shopify's retries don't pile up. Every handler is idempotent:
 * Shopify can deliver a webhook more than once and the background function
 * retries a failed run.
 *
 *   ORDERS_PAID             repair quote paid → processRepairPayment; any
 *                           other order → Items + warranty/Care cover,
 *                           care_activated (and the Add Care offer tag
 *                           removed), trade-in linking (when enabled)
 *   REFUNDS_CREATE          processRefund (once per refund id) + Care refunds
 *   CUSTOMERS_DATA_REQUEST  exportCustomerData (JSON export, shown in the admin)
 *   CUSTOMERS_REDACT        redactCustomer
 *   SHOP_REDACT             redactShop
 *
 * (APP_UNINSTALLED is handled inline in its route: one quick DB write.)
 */

export interface WebhookJobDeps {
  db?: typeof prisma;
  /** The shop's Admin client; defaults to its offline session. */
  client?: (shop: Shop) => Promise<AdminGraphqlClient>;
  notifyDeps?: Pick<NotificationDeps, "store" | "enqueue">;
  storage?: FileStorage;
  enqueue?: (name: "outbound-webhook", payload: JobPayload) => Promise<void>;
}

let configured: WebhookJobDeps = {};

/** Overrides the job's dependencies (tests); {} goes back to the defaults. */
export function setWebhookJobDeps(deps: WebhookJobDeps) {
  configured = deps;
}

async function defaultClient(shop: Shop): Promise<AdminGraphqlClient> {
  const { adminClientForShop } = await import("../shopify/client.server");
  return adminClientForShop(shop.shopifyDomain);
}

type Context = Omit<WebhookJobDeps, "db" | "client"> & {
  db: typeof prisma;
  /** Memoised: opened only by handlers that call Shopify. */
  client: () => Promise<AdminGraphqlClient>;
  webhookId: string | null;
};

type TopicHandler = (shop: Shop, payload: unknown, ctx: Context) => Promise<void>;

const ordersPaid: TopicHandler = async (shop, payload, ctx) => {
  if (shop.uninstalledAt) return;
  const body = payload as PaidOrderBody & OrderWebhookBody;
  const result = await processRepairPayment(shop, body, {
    db: ctx.db,
    client: isRepairOrder(shop, body) ? await ctx.client() : undefined,
    notifyDeps: ctx.notifyDeps,
    enqueue: ctx.enqueue,
  });
  let items = 0;
  if (result === "not_repair") {
    const order = orderFromWebhook(body);
    const recorder = new ItemRecorder(shop, {
      db: ctx.db,
      facts: new ProductFactsLoader(await ctx.client(), { shopKey: shop.shopifyDomain }),
    });
    items = (await recorder.record(order)).length;
    await notifyCareActivated(shop, recorder.careResult.covers, {
      db: ctx.db,
      deps: ctx.notifyDeps,
    });
    // Bought Care: no longer in the "Add Care" offer segment.
    if (recorder.careResult.covers.length > 0 && order.customerId)
      await removeCareOfferTag(await ctx.client(), [order.customerId]);
    if (tradeInEnabled(shop))
      await linkTradeInsToOrder(shop, order, {
        db: ctx.db,
        notifyOptions: { deps: ctx.notifyDeps },
      });
  }
  console.info(
    `[job:webhook] orders/paid shop=${shop.shopifyDomain} order=${body.id} result=${result} items=${items}`,
  );
};

const refundsCreate: TopicHandler = async (shop, payload, ctx) => {
  if (shop.uninstalledAt) return;
  const body = payload as RefundWebhookBody;
  const count = await processRefund(shop, body, {
    db: ctx.db,
    careOptions: {
      client: ctx.client,
      currency: async () => (await fetchShopInfo(await ctx.client())).currencyCode,
      notifyOptions: { deps: ctx.notifyDeps },
    },
  });
  console.info(
    `[job:webhook] refunds/create shop=${shop.shopifyDomain} order=${body.order_id} items_refunded=${count}`,
  );
};

const customersDataRequest: TopicHandler = async (shop, payload, ctx) => {
  const body = (payload ?? {}) as { data_request?: { id?: unknown } };
  const requestId = String(body.data_request?.id ?? ctx.webhookId ?? Date.now());
  const result = await exportCustomerData(shop, customerRefFromWebhook(payload), requestId, {
    db: ctx.db,
    storage: ctx.storage,
  });
  // Optional staff alert (Flow "Send internal email"); the admin shows the export either way.
  const { tickets, items, tradeIns, deliveries } = result.counts;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  await notify(
    shop.shopifyDomain,
    "data_request",
    { customerId: null, email: null },
    {
      requestId,
      customer: result.customer,
      summary: [
        plural(tickets, "repair ticket"),
        plural(items, "item"),
        plural(tradeIns, "trade-in"),
        plural(deliveries, "notification"),
      ].join(", "),
      downloadUrl: result.url,
      adminUrl: adminAppUrl(shop.shopifyDomain, "settings#data-requests"),
    },
    { db: ctx.db, deps: ctx.notifyDeps },
  );
  console.info(
    `[job:webhook] customers/data_request shop=${shop.shopifyDomain} tickets=${result.counts.tickets} items=${result.counts.items} trade_ins=${result.counts.tradeIns}`,
  );
};

const customersRedact: TopicHandler = async (shop, payload, ctx) => {
  const summary = await redactCustomer(shop.id, customerRefFromWebhook(payload), {
    db: ctx.db,
    storage: ctx.storage,
  });
  console.info(`[job:webhook] customers/redact shop=${shop.shopifyDomain}`, summary);
};

const handlers: Record<string, TopicHandler> = {
  ORDERS_PAID: ordersPaid,
  REFUNDS_CREATE: refundsCreate,
  CUSTOMERS_DATA_REQUEST: customersDataRequest,
  CUSTOMERS_REDACT: customersRedact,
};

/** "orders/paid" and "ORDERS_PAID" both work. */
export const normaliseTopic = (topic: string) => topic.replace(/\//g, "_").toUpperCase();

export async function webhookJob(job: JobPayload): Promise<void> {
  const { topic, shop: shopDomain, payload, webhookId } = job as {
    topic: string;
    shop: string;
    payload: unknown;
    webhookId?: string;
  };
  const name = normaliseTopic(String(topic));
  const db = configured.db ?? prisma;

  if (name === "SHOP_REDACT") {
    await redactShop(shopDomain, { db, storage: configured.storage });
    return;
  }
  const handler = handlers[name];
  if (!handler) {
    console.warn(`[job:webhook] ${topic} for ${shopDomain}: no handler, ignored`);
    return;
  }
  const shop = await db.shop.findUnique({ where: { shopifyDomain: shopDomain } });
  if (!shop) {
    console.info(`[job:webhook] ${topic} skipped: no shop '${shopDomain}'`);
    return;
  }
  const openClient = configured.client ?? defaultClient;
  let client: Promise<AdminGraphqlClient> | undefined;
  await handler(shop, payload, {
    ...configured,
    db,
    client: () => (client ??= openClient(shop)),
    webhookId: webhookId ?? null,
  });
}
