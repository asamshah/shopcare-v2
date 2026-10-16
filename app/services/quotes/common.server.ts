/**
 * Shared plumbing for the quote and ticket-status services (the w2-backend
 * service contract): result types, the long-lived row-lock transaction,
 * loading a quote within its shop, the Shopify client, and the after-commit
 * side effects (outbound webhooks, notifications) Rails ran from callbacks
 * and jobs.
 */
import type { PrismaClient, Quotation, RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import { withRowLock, type Db } from "../../lib/db-lock.server";
import { settingsOf } from "../../models/shop.server";
import type { ActivityAuthor } from "../../models/ticket-activity.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { emitOutboundWebhook } from "../../jobs/outbound-webhook.server";
import type { NotificationDeps } from "../notifications.server";

export type Result<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Who is acting: "staff" (or a staff member's name/email), "customer" or "system". */
export type Actor = string;

export function authorFor(actor: Actor | null | undefined): ActivityAuthor {
  if (actor === "system" || actor === "customer") return actor;
  return "staff";
}

export interface ServiceOptions {
  /** The shop's Admin API client; defaults to its offline session. */
  client?: AdminGraphqlClient;
  db?: PrismaClient;
  now?: Date;
  /** Notification wiring (tests); defaults to getNotificationDeps(). */
  notifyDeps?: Pick<NotificationDeps, "store" | "enqueue">;
  /** Enqueues jobs (outbound webhook); defaults to app/lib/background.server. */
  enqueue?: (name: "outbound-webhook", payload: Record<string, unknown>) => Promise<void>;
  logger?: Pick<Console, "error" | "info" | "warn">;
}

/**
 * Runs `fn` holding a row lock (Rails `with_lock`) in a transaction long
 * enough for the Shopify calls made while it's held (draft order create,
 * invoice send): the lock is what makes a double-submit wait and then see
 * the first one's result.
 */
export function withLock<T>(
  db: PrismaClient,
  table: string,
  id: number,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await withRowLock(tx, table, id);
      return fn(tx);
    },
    { maxWait: 15_000, timeout: 90_000 },
  );
}

export type QuoteWithTicket = Quotation & {
  repairTicket: RepairTicket & { shop: Shop };
};

/** The quotation, if it belongs to the shop. */
export function findShopQuotation(
  db: Db,
  shopId: number,
  quotationId: number,
): Promise<QuoteWithTicket | null> {
  return db.quotation.findFirst({
    where: { id: quotationId, repairTicket: { shopId } },
    include: { repairTicket: { include: { shop: true } } },
  });
}

export async function clientFor(
  shop: Pick<Shop, "shopifyDomain">,
  client?: AdminGraphqlClient,
): Promise<AdminGraphqlClient> {
  if (client) return client;
  const { adminClientForShop } = await import("../../shopify/client.server");
  return adminClientForShop(shop.shopifyDomain);
}

/** The shop's currency, read from Shopify once per call site. */
export function shopCurrencyOf(client: AdminGraphqlClient): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () =>
    (pending ??= import("../../shopify/shop.server").then(
      async ({ fetchShopInfo }) => (await fetchShopInfo(client)).currencyCode,
    ));
}

/** Rails `quote_valid_days.days.from_now.end_of_day` (UTC). */
export function endOfDayAfter(now: Date, days: number): Date {
  const end = new Date(now.getTime() + days * 86_400_000);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/** Rails OutboundWebhookJob.emit: only when the shop has a webhook URL. */
export async function emitTicketWebhook(
  shop: Pick<Shop, "id" | "settings">,
  ticketId: number,
  event: string,
  detail: string | null = null,
  options: Pick<ServiceOptions, "enqueue" | "logger"> = {},
): Promise<void> {
  const url = settingsOf(shop).webhook_url;
  try {
    await emitOutboundWebhook(
      typeof url === "string" ? url : null,
      { shopId: String(shop.id), ticketId: String(ticketId), event, detail },
      options.enqueue,
    );
  } catch (error) {
    (options.logger ?? console).error(
      `[outbound-webhook] ${event} ticket=${ticketId} not queued`,
      error,
    );
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
