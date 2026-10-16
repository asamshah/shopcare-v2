/** Port of Rails test/services/repairs/quote_sender_test.rb (sendQuote / resendInvoice). */
import type { RepairTicket, Shop } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../../app/db.server";
import { claimsCount, createCover, warrantyCoverFor } from "../../../../app/models/cover.server";
import {
  applyCover,
  decisionToken,
  findByDecisionToken,
  tokenDigest,
  validUntil,
} from "../../../../app/models/quotation.server";
import { statutoryRightsNotice } from "../../../../app/models/statutory-rights.server";
import { expireQuote, declineQuote } from "../../../../app/services/quotes/decision.server";
import { resendInvoice } from "../../../../app/services/quotes/resend.server";
import { sendQuote } from "../../../../app/services/quotes/send.server";
import {
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createWarrantyPolicyFor,
} from "../../../support/factories";
import { FakeDraftOrders } from "../../../support/fake-draft-orders";
import { captureEnqueue, dbNotifyDeps, paidQuote, quoteShop, sentQuote } from "../../../support/quotes";

describe("sendQuote", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let api: FakeDraftOrders;
  let outbound: ReturnType<typeof captureEnqueue>;

  const send = (quotationId: number, extra: Partial<Parameters<typeof sendQuote>[0]> = {}) =>
    sendQuote({
      shopId: shop.id,
      quotationId,
      actor: "staff",
      client: api.client,
      enqueue: outbound.enqueue,
      ...extra,
    });
  const resend = (quotationId: number) =>
    resendInvoice({ shopId: shop.id, quotationId, actor: "staff", client: api.client, enqueue: outbound.enqueue });
  const activities = () =>
    prisma.ticketActivity.findMany({ where: { repairTicketId: ticket.id }, orderBy: { id: "desc" } });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
    shop = await quoteShop("qs-test.myshopify.com");
    ticket = await createRepairTicketFor(shop, {
      customerEmail: "c@example.com",
      shopifyCustomerId: "77",
      productTitle: "Boot",
      status: "assessing",
    });
    api = new FakeDraftOrders();
    outbound = captureEnqueue();
  });

  it("creates the draft order and has Shopify email its invoice as the quote", async () => {
    const quotation = await paidQuote(ticket.id);
    const result = await send(quotation.id, { now: new Date(Date.UTC(2026, 9, 16, 10)) });

    expect(result).toEqual({ ok: true, warranty: false });
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([q.status, q.shopifyDraftOrderId, q.shopifyDraftOrderUrl]).toEqual([
      "sent",
      "999",
      "https://shop.test/invoice/abc",
    ]);
    expect(q.decisionExpiresAt).toEqual(new Date(Date.UTC(2026, 9, 30, 23, 59, 59, 999)));
    expect(api.kinds()).toEqual(["create", "invoice"]);
    const input = api.calls[0][1].input as Record<string, unknown>;
    expect(input.email).toBe("c@example.com");
    const [, invoice] = api.calls[1];
    expect(invoice.id).toBe("gid://shopify/DraftOrder/999");
    const email = invoice.email as { subject: string; customMessage: string };
    expect(email.subject).toBe("Your repair quote from Test Shop");
    const review = `https://qs-test.myshopify.com/apps/repairs/quotes/${decisionToken(q)}`;
    expect(email.customMessage.split("\n\n")).toEqual([
      "Here's the quote for your repair.",
      `Repair #${ticket.id}: Boot.`,
      "This quote is valid until 30 October 2026.",
      "Pay to accept and we'll start your repair.",
      `Don't want to go ahead? Decline here: ${review}`,
    ]);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("quoted");
    expect((await activities())[0].body).toMatch(
      /Shopify emailed the customer its invoice .*valid until 30 October 2026/,
    );
    const saved = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect((saved.settings as Record<string, unknown>).shop_name).toBe("Test Shop");
    expect(outbound.jobs).toEqual([]); // no webhook URL configured
  });

  it("the merchant's subject and message, and the cover's terms, go in the email", async () => {
    await prisma.shop.update({
      where: { id: shop.id },
      data: { settings: { currency: "GBP", email: { subject: "Your quote", body: "Hi from the workshop." } } },
    });
    const item = await createItemFor(shop, { productTitle: "Boot" });
    const policy = await createWarrantyPolicyFor(shop, { name: "Care", months: 12, outcome: "discount", discountPercent: 25 });
    const cover = await createCover(warrantyCoverFor(item, policy));
    const quotation = await paidQuote(ticket.id, 40);
    await applyCover(quotation.id, cover);

    expect((await send(quotation.id)).ok).toBe(true);

    const email = api.calls.at(-1)![1].email as { subject: string; customMessage: string };
    expect(email.subject).toBe("Your quote");
    expect(email.customMessage.split("\n\n").slice(0, 3)).toEqual([
      "Hi from the workshop.",
      `Repair #${ticket.id}: Boot.`,
      `Care: 25% off repairs. ${statutoryRightsNotice()}`,
    ]);
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([q.status, Number(q.subtotal)]).toEqual(["sent", 30]);
    expect(claimsCount(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(0);
  });

  it("repair-variant lines carry the quote's price as priceOverride", async () => {
    const quotation = await createQuotationFor(ticket.id, { currency: "GBP" });
    await createLineItem(quotation.id, { kind: "repair", title: "Resole", unitPrice: 55, shopifyVariantId: "900" });
    await send(quotation.id);
    const line = (api.calls[0][1].input as { lineItems: Record<string, unknown>[] }).lineItems[0];
    expect(line).toMatchObject({
      variantId: "gid://shopify/ProductVariant/900",
      priceOverride: { amount: "55.00", currencyCode: "GBP" },
    });
  });

  it("stores the review link token encrypted and finds it by its digest", async () => {
    const quotation = await paidQuote(ticket.id);
    await send(quotation.id);
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    const token = decisionToken(q)!;
    expect(q.decisionTokenCiphertext).not.toContain(token);
    expect(q.decisionTokenDigest).toBe(tokenDigest(token));
    expect((await findByDecisionToken(shop.id, token))?.id).toBe(quotation.id);
  });

  it("uses the shop's quote validity", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { quote_valid_days: "3" } } });
    const quotation = await paidQuote(ticket.id);
    const now = new Date(Date.UTC(2026, 9, 16, 10));
    await send(quotation.id, { now });
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(q.decisionExpiresAt).toEqual(new Date(Date.UTC(2026, 9, 19, 23, 59, 59, 999)));
  });

  it("no customer quote email goes through Flow or Klaviyo: Shopify's invoice is the quote", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { notifications: { flow: true } } } });
    await send((await paidQuote(ticket.id)).id);
    const deliveries = await prisma.notificationDelivery.findMany({ where: { shopId: shop.id } });
    expect(deliveries.filter((d) => d.event.startsWith("quote"))).toEqual([]);
    expect([...new Set(deliveries.map((d) => d.event))]).toEqual(["repair_status_changed"]);
  });

  it("refuses to re-send a quote that has already been sent", async () => {
    const quotation = await paidQuote(ticket.id);
    await prisma.quotation.update({ where: { id: quotation.id }, data: { status: "sent" } });
    const result = await send(quotation.id);
    expect(result.ok).toBe(false);
    expect(api.calls).toEqual([]);
  });

  it("a double-submit sends the quote once", async () => {
    const quotation = await paidQuote(ticket.id);
    const results = await Promise.all([send(quotation.id), send(quotation.id)]);
    expect(results.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(api.kinds()).toEqual(["create", "invoice"]);
  });

  it("a failed invoice leaves the quote a draft; the retry reuses and updates the draft order", async () => {
    const quotation = await paidQuote(ticket.id);
    api.failInvoice = true;
    const result = await send(quotation.id);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch("Shopify timed out");
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([q.status, q.shopifyDraftOrderId]).toEqual(["draft", "999"]);

    api.failInvoice = false;
    await prisma.quotationLineItem.updateMany({ where: { quotationId: quotation.id }, data: { unitPrice: 30 } });
    expect((await send(quotation.id)).ok).toBe(true);
    expect(api.kinds()).toEqual(["create", "invoice", "update", "invoice"]);
    const update = api.calls[2][1].input as { lineItems: { originalUnitPriceWithCurrency: { amount: string } }[] };
    expect(update.lineItems[0].originalUnitPriceWithCurrency.amount).toBe("30.00");
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("sent");
  });

  it("auto-completes a £0 quote without an invoice", async () => {
    const quotation = await paidQuote(ticket.id, 0);
    const result = await send(quotation.id);
    expect(result).toEqual({ ok: true, warranty: true, ticketStatus: "awaiting_item" });
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect(q.status).toBe("paid");
    expect(q.decisionTokenDigest).toBeNull();
    expect(q.shopifyOrderId).toBe("5001");
    // The customer still has the item: they're sent a postage slip.
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("awaiting_item");
    expect(api.kinds()).toEqual(["create", "complete"]);
  });

  it("a £0 quote for an item the workshop already has starts the repair", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { itemReceivedAt: new Date() } });
    const quotation = await paidQuote(ticket.id, 0);
    expect(await send(quotation.id)).toEqual({ ok: true, warranty: true, ticketStatus: "in_repair" });
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("in_repair");
    const activity = await prisma.ticketActivity.findFirstOrThrow({ where: { repairTicketId: ticket.id, activityType: "quote_sent" } });
    expect(activity.body).toMatch(/repair started\.$/);
  });

  it("refuses to send an empty quote", async () => {
    const quotation = await createQuotationFor(ticket.id, { status: "draft" });
    const result = await send(quotation.id);
    expect(!result.ok && result.error).toMatch(/line item/i);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } })).status).toBe("draft");
  });

  it("free cover completes the repair without payment and counts the claim", async () => {
    const item = await createItemFor(shop, { productTitle: "Boot" });
    const policy = await createWarrantyPolicyFor(shop, { name: "12-month warranty", months: 12 });
    const cover = await createCover(warrantyCoverFor(item, policy));
    const quotation = await paidQuote(ticket.id, 20);
    await applyCover(quotation.id, cover);

    const result = await send(quotation.id);
    expect(result.ok && result.warranty).toBe(true);
    expect(api.kinds()).toEqual(["create", "complete"]);
    expect(claimsCount(await prisma.cover.findUniqueOrThrow({ where: { id: cover.id } }))).toBe(1);
    expect((await activities()).some((a) => a.body?.startsWith("Covered by 12-month warranty"))).toBe(true);
  });

  it("sends the quote_sent outbound webhook when the shop has one", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: { webhook_url: "https://hooks.example/x" } } });
    await send((await paidQuote(ticket.id)).id);
    expect(outbound.jobs).toEqual([
      { name: "outbound-webhook", payload: { shopId: String(shop.id), ticketId: String(ticket.id), event: "quote_sent", detail: null } },
    ]);
  });

  it("Resend invoice emails it again; an expired quote reopens with a new draft order", async () => {
    const quotation = await sentQuote(shop, ticket.id, api);
    const token = decisionToken(quotation);

    expect((await resend(quotation.id)).ok).toBe(true);
    expect(api.kinds()).toEqual(["create", "invoice", "update", "invoice"]);

    await prisma.quotation.update({ where: { id: quotation.id }, data: { decisionExpiresAt: new Date(Date.now() - 60_000) } });
    await expireQuote({ shopId: shop.id, quotationId: quotation.id, client: api.client, enqueue: outbound.enqueue });
    let q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([(await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status, q.shopifyDraftOrderId]).toEqual(["quote_declined", null]);

    expect((await resend(quotation.id)).ok).toBe(true);
    expect(api.kinds().slice(-3)).toEqual(["delete", "create", "invoice"]);
    q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    expect([q.status, decisionToken(q), q.shopifyDraftOrderId]).toEqual(["sent", token, "999"]);
    expect(q.decisionExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("quoted");
    expect((await activities()).map((a) => a.body)).toContain(
      `Invoice re-sent to the customer (£24.00, valid until ${validUntil(q)}).`,
    );
  });

  it("Resend refuses a declined or paid quote", async () => {
    const quotation = await sentQuote(shop, ticket.id, api);
    await declineQuote({ shopId: shop.id, quotationId: quotation.id, by: "customer", client: api.client, enqueue: outbound.enqueue });
    expect((await resend(quotation.id)).ok).toBe(false);
  });

  it("refuses a quote from another shop", async () => {
    const other = await quoteShop("other-qs.myshopify.com");
    const quotation = await paidQuote(ticket.id);
    expect(await sendQuote({ shopId: other.id, quotationId: quotation.id, actor: "staff", client: api.client })).toEqual({
      ok: false,
      error: "Quote not found.",
    });
  });
});
