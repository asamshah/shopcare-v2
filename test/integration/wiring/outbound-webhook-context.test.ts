/** The outbound-webhook job's Prisma loader (Rails OutboundWebhookJob#perform). */
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { encrypt } from "../../../app/lib/encryption.server";
import { performOutboundWebhook } from "../../../app/jobs/outbound-webhook.server";
import { loadOutboundWebhookContext } from "../../../app/services/repairs/outbound-webhook-context.server";
import { createQuotationFor, createRepairTicketFor, createShop } from "../../support/factories";

describe("loadOutboundWebhookContext", () => {
  it("loads the URL, decrypted secret, ticket and latest quotation, by shop id or domain", async () => {
    const shop = await createShop({
      settings: { webhook_url: "https://hooks.example/shopcare" },
      webhookSecretCiphertext: encrypt("s3cret", "Shop.webhookSecret"),
    });
    const ticket = await createRepairTicketFor(shop, { productTitle: "Aria Boot" });
    await createQuotationFor(ticket.id, { subtotal: 10, createdAt: new Date("2026-10-01") });
    await createQuotationFor(ticket.id, { subtotal: 45, status: "sent" });

    const byId = await loadOutboundWebhookContext(String(shop.id), String(ticket.id));
    expect(byId).toMatchObject({
      url: "https://hooks.example/shopcare",
      secret: "s3cret",
      shopDomain: shop.shopifyDomain,
      ticket: { id: ticket.id, productTitle: "Aria Boot" },
      quotation: { status: "sent", currency: "GBP", subtotal: "45" },
    });
    expect(await loadOutboundWebhookContext(shop.shopifyDomain, String(ticket.id))).toMatchObject({
      ticket: { id: ticket.id },
    });
  });

  it("is null for another shop's ticket or a missing shop", async () => {
    const shop = await createShop();
    const other = await createShop();
    const ticket = await createRepairTicketFor(other);
    expect(await loadOutboundWebhookContext(String(shop.id), String(ticket.id))).toBeNull();
    expect(await loadOutboundWebhookContext("nope.myshopify.com", String(ticket.id))).toBeNull();
    expect(await loadOutboundWebhookContext(String(shop.id), "abc")).toBeNull();
  });

  it("feeds the job: no URL, no delivery", async () => {
    const shop = await createShop();
    const ticket = await createRepairTicketFor(shop);
    const result = await performOutboundWebhook(
      { shopId: String(shop.id), ticketId: String(ticket.id), event: "submitted" },
      { loadContext: (s, t) => loadOutboundWebhookContext(s, t, prisma) },
    );
    expect(result).toBeNull();
  });
});
