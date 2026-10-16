/**
 * Quote fixtures (Rails QuoteFixtures) and notification wiring for service
 * tests: deliveries go to the real `notification_deliveries` table, and the
 * enqueued job ids are captured instead of run.
 */
import type { Shop } from "@prisma/client";
import { vi } from "vitest";
import prisma from "../../app/db.server";
import { setNotificationDeps } from "../../app/services/notifications.server";
import { PrismaNotificationStore } from "../../app/services/notifications/prisma-store.server";
import { sendQuote } from "../../app/services/quotes/send.server";
import { createLineItem, createQuotationFor, createShop } from "./factories";
import type { FakeDraftOrders } from "./fake-draft-orders";
import { buildDeps } from "./notifications";

/** NotificationDeps over Postgres, enqueue captured; also the job default. */
export function dbNotifyDeps() {
  const built = buildDeps({ store: new PrismaNotificationStore(prisma) });
  setNotificationDeps(built.deps);
  return built;
}

/** Captures outbound-webhook enqueues. */
export function captureEnqueue() {
  const jobs: { name: string; payload: Record<string, unknown> }[] = [];
  const enqueue = vi.fn(async (name: string, payload: Record<string, unknown>) => {
    jobs.push({ name, payload });
  });
  return { jobs, enqueue };
}

export function quoteShop(domain: string, settings: Record<string, unknown> = {}): Promise<Shop> {
  return createShop({ shopifyDomain: domain, settings: { currency: "GBP", ...settings } });
}

/** A draft quote with one "Sole replacement" line. */
export async function paidQuote(ticketId: number, price = 24) {
  const quotation = await createQuotationFor(ticketId, { currency: "GBP" });
  await createLineItem(quotation.id, { kind: "repair", title: "Sole replacement", quantity: 1, unitPrice: price });
  return quotation;
}

/** A quote whose invoice was sent, awaiting payment. */
export async function sentQuote(
  shop: Shop,
  ticketId: number,
  api: FakeDraftOrders,
  price = 24,
) {
  const quotation = await paidQuote(ticketId, price);
  const result = await sendQuote({
    shopId: shop.id,
    quotationId: quotation.id,
    actor: "staff",
    client: api.client,
    enqueue: async () => {},
  });
  if (!result.ok) throw new Error(result.error);
  return prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
}
