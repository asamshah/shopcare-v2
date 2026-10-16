/**
 * "Send quote" (contract service, w2-backend). Port of Repairs::QuoteSender#call.
 *
 * The Shopify invoice is the quote: the quote's draft order is created (or a
 * reused one brought up to date, every repair-variant line carrying the
 * quote's price as `priceOverride`) and Shopify emails its invoice, from the
 * store, to the customer's email (guests included). Its subject is "Your
 * repair quote from <store>" (or Settings → email subject) and its message
 * says what's being repaired, the cover, how long the quote is valid, that
 * paying accepts it, and links to the review page to decline. Paying accepts
 * the quote (orders/paid → processRepairPayment); declining or expiry deletes
 * the draft order (decision.server.ts).
 *
 * A £0 quote (warranty / Care) needs no payment: its draft order is completed
 * straight away (no invoice email), the quote is paid and the ticket moves on
 * like a paid one: to awaiting_item (postage slip emailed), or to in_repair
 * when the workshop already has the item.
 *
 * The quotation stays row-locked for the whole send, so a double-submit waits
 * and then finds it already sent. Shopify errors are caught inside the lock,
 * so a draft order created by an attempt that failed part-way is still saved
 * on the quotation and reused (updated) by the next one.
 */
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import prisma from "../../db.server";
import type { Db } from "../../lib/db-lock.server";
import { coverName, recordClaim } from "../../models/cover.server";
import {
  coverApplied,
  coverSummary,
  decisionToken,
  formattedSubtotal,
  issueDecisionToken,
  isWarrantyQuote,
  recalculateSubtotal,
  validUntil,
} from "../../models/quotation.server";
import { statusAfterPayment } from "../../models/repair-ticket.server";
import {
  proxyUrl,
  quoteValidDays,
  settingsOf,
  storeName,
} from "../../models/shop.server";
import { createTicketActivity } from "../../models/ticket-activity.server";
import {
  completeDraftOrder,
  sendDraftOrderInvoice,
} from "../../shopify/draft-orders.server";
import type { AdminGraphqlClient } from "../../shopify/graphql.server";
import { fetchShopName } from "../../shopify/shop.server";
import { ensureQuoteDraftOrder } from "../repairs/quote-draft-order.server";
import { notifyRepairStatusChanged } from "../repairs/ticket-status.server";
import {
  authorFor,
  clientFor,
  emitTicketWebhook,
  endOfDayAfter,
  errorMessage,
  findShopQuotation,
  shopCurrencyOf,
  withLock,
  type Actor,
  type Result,
  type ServiceOptions,
} from "./common.server";

export interface QuoteActionInput extends ServiceOptions {
  shopId: number;
  quotationId: number;
  actor: Actor;
}

export type SendQuoteResult = Result<{
  warranty: boolean;
  /** Where a £0 quote moved the ticket (awaiting_item or in_repair). */
  ticketStatus?: string;
}>;

/** Work to run once the lock's transaction has committed. */
export type AfterCommit = (() => Promise<void>)[];

export async function sendQuote({
  shopId,
  quotationId,
  actor,
  db = prisma,
  now = new Date(),
  ...options
}: QuoteActionInput): Promise<SendQuoteResult> {
  const found = await findShopQuotation(db, shopId, quotationId);
  if (!found) return { ok: false, error: "Quote not found." };
  const shop = found.repairTicket.shop;
  const client = await clientFor(shop, options.client);
  const after: AfterCommit = [];

  const result = await withLock(db, "quotations", quotationId, async (tx): Promise<SendQuoteResult> => {
    const current = await tx.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    if (current.status !== "draft")
      return { ok: false, error: "This quote has already been sent." };
    const quotation = await recalculateSubtotal(quotationId, tx);
    if ((await tx.quotationLineItem.count({ where: { quotationId } })) === 0)
      return { ok: false, error: "Add at least one line item before sending." };

    const context = { tx, shop, client, now, actor, after, options };
    return isWarrantyQuote(quotation)
      ? completeInShopify(quotation, context)
      : sendInvoice(quotation, context);
  });

  for (const step of after) await step();
  return result;
}

interface SendContext {
  tx: Db;
  shop: Shop;
  client: AdminGraphqlClient;
  now: Date;
  actor: Actor;
  after: AfterCommit;
  options: ServiceOptions;
}

export function quoteExpiry(shop: Pick<Shop, "settings">, now: Date): Date {
  return endOfDayAfter(now, quoteValidDays(shop));
}

async function sendInvoice(
  quotation: Quotation,
  context: SendContext,
): Promise<SendQuoteResult> {
  const { tx, shop, now, after, options } = context;
  try {
    const token = await issueDecisionToken(quotation.id, quoteExpiry(shop, now), tx);
    return await emailInvoice(
      quotation.id,
      token,
      "Quote sent: Shopify emailed the customer its invoice to pay or decline",
      context,
      async () => {
        await tx.quotation.update({
          where: { id: quotation.id },
          data: { status: "sent", sentAt: now },
        });
        const ticket = await setTicketStatus(tx, quotation.repairTicketId, "quoted");
        after.push(() => emitTicketWebhook(shop, ticket.ticket.id, "quote_sent", null, options));
        if (ticket.changed)
          after.push(() =>
            notifyRepairStatusChanged(shop, ticket.ticket, { deps: options.notifyDeps }),
          );
      },
    );
  } catch (error) {
    return failure(quotation, error, options);
  }
}

/**
 * Brings the draft order up to date, has Shopify email its invoice, then
 * records the send (`record`) and logs it. Shared with resendInvoice.
 */
export async function emailInvoice(
  quotationId: number,
  token: string,
  summary: string,
  { tx, shop, client, actor, options }: SendContext,
  record?: () => Promise<void>,
): Promise<SendQuoteResult> {
  try {
    const draftId = await ensureQuoteDraftOrder(quotationId, client, {
      db: tx,
      shopCurrency: shopCurrencyOf(client),
    });
    const quotation = await tx.quotation.findUniqueOrThrow({
      where: { id: quotationId },
      include: { cover: true, repairTicket: true },
    });
    await sendDraftOrderInvoice(client, draftId, {
      subject: await emailSubject(shop, client, tx),
      customMessage: emailMessage(shop, quotation, quotation.repairTicket, token),
    });
    if (record) await record();
    await createTicketActivity(
      {
        repairTicketId: quotation.repairTicketId,
        activityType: "quote_sent",
        author: authorFor(actor),
        body: `${summary} (${formattedSubtotal(quotation)}, valid until ${validUntil(quotation)}).`,
      },
      tx,
    );
    return { ok: true, warranty: false };
  } catch (error) {
    return failure({ id: quotationId }, error, options);
  }
}

async function completeInShopify(
  quotation: Quotation,
  { tx, shop, client, now, after, options }: SendContext,
): Promise<SendQuoteResult> {
  try {
    const draftId = await ensureQuoteDraftOrder(quotation.id, client, {
      db: tx,
      shopCurrency: shopCurrencyOf(client),
    });
    const completed = await completeDraftOrder(client, draftId);
    const paid = await tx.quotation.update({
      where: { id: quotation.id },
      data: {
        status: "paid",
        sentAt: now,
        paidAt: now,
        shopifyOrderId: completed.orderId ?? quotation.shopifyOrderId,
      },
      include: { cover: true },
    });
    const next = statusAfterPayment(
      await tx.repairTicket.findUniqueOrThrow({ where: { id: quotation.repairTicketId } }),
    );
    const ticket = await setTicketStatus(tx, quotation.repairTicketId, next);
    const applied = coverApplied(paid) && paid.cover;
    if (applied) await recordClaim(paid.cover!.id, tx);
    const reason = applied ? `Covered by ${coverName(paid.cover!)}:` : "No-charge";
    const outcome =
      next === "in_repair" ? "repair started" : "waiting for the customer to send the item";
    await createTicketActivity(
      {
        repairTicketId: quotation.repairTicketId,
        activityType: "quote_sent",
        author: "system",
        body: `${reason} (${formattedSubtotal(paid)}) quote auto-completed — ${outcome}.`,
      },
      tx,
    );
    after.push(() => emitTicketWebhook(shop, ticket.ticket.id, "quote_sent", null, options));
    if (ticket.changed)
      after.push(() =>
        notifyRepairStatusChanged(shop, ticket.ticket, { deps: options.notifyDeps }),
      );
    return { ok: true, warranty: true, ticketStatus: next };
  } catch (error) {
    return failure(quotation, error, options);
  }
}

/** Sets the ticket's status; `changed` says whether it was different. */
export async function setTicketStatus(
  tx: Db,
  ticketId: number,
  status: string,
): Promise<{ ticket: RepairTicket; changed: boolean }> {
  const ticket = await tx.repairTicket.findUniqueOrThrow({ where: { id: ticketId } });
  if (ticket.status === status) return { ticket, changed: false };
  const updated = await tx.repairTicket.update({ where: { id: ticketId }, data: { status } });
  return { ticket: updated, changed: true };
}

async function emailSubject(shop: Shop, client: AdminGraphqlClient, db: Db): Promise<string> {
  const custom = (settingsOf(shop).email as Record<string, unknown> | undefined)?.subject;
  if (typeof custom === "string" && custom.trim()) return custom;
  const name = await storeName(shop, { shopName: () => fetchShopName(client) }, db);
  return `Your repair quote from ${name}`;
}

/**
 * The invoice email's message: the repair, the cover, how long the quote is
 * valid, that paying accepts it, and where to decline.
 */
export function emailMessage(
  shop: Pick<Shop, "shopifyDomain" | "settings">,
  quotation: Parameters<typeof coverSummary>[0],
  ticket: Pick<RepairTicket, "id" | "productTitle">,
  token: string,
): string {
  const body = (settingsOf(shop).email as Record<string, unknown> | undefined)?.body;
  const intro =
    typeof body === "string" && body.trim() ? body : "Here's the quote for your repair.";
  const repair = `Repair #${ticket.id}${ticket.productTitle?.trim() ? `: ${ticket.productTitle}` : ""}.`;
  return [
    intro,
    repair,
    coverSummary(quotation),
    `This quote is valid until ${validUntil(quotation)}.`,
    "Pay to accept and we'll start your repair.",
    `Don't want to go ahead? Decline here: ${proxyUrl(shop, `quotes/${token}`)}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
}

function failure(
  quotation: Pick<Quotation, "id">,
  error: unknown,
  options: ServiceOptions,
): SendQuoteResult {
  (options.logger ?? console).error(
    `[quotes/send] quotation=${quotation.id} ${errorMessage(error)}`,
  );
  return { ok: false, error: `Couldn't send the quote from Shopify: ${errorMessage(error)}` };
}

/** The review-link token of a quote that has one. */
export function existingToken(quotation: Pick<Quotation, "decisionTokenCiphertext">) {
  return decisionToken(quotation);
}
