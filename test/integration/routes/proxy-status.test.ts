/** Port of Rails test/integration/proxy_status_test.rb (GET /proxy/status). */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { careCoverFor, createCover } from "../../../app/models/cover.server";
import { issueDecisionToken, updateQuotation } from "../../../app/models/quotation.server";
import { loader } from "../../../app/routes/proxy.status";
import {
  createCarePlanFor,
  createItemFor,
  createQuotationFor,
  createRepairTicketFor,
  daysAgo,
} from "../../support/factories";
import {
  fakeStorefront,
  installedShop,
  runRoute,
  signedGet,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "status-test.myshopify.com";

describe("GET /proxy/status", () => {
  let shop: Shop;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain);
    fakes = fakeStorefront();
  });
  afterEach(() => fakes.restore());

  const get = async (customerId: string) =>
    (await (await runRoute(loader, signedGet("/proxy/status", domain, { customerId }))).json()) as {
      logged_in: boolean;
      tickets: Record<string, never>[];
    };

  it("returns only the logged-in customer's own tickets", async () => {
    const mine = await createRepairTicketFor(shop, {
      customerEmail: "me@example.com",
      shopifyCustomerId: "777",
      productTitle: "Boot",
      status: "in_repair",
    });
    await createRepairTicketFor(shop, { customerEmail: "other@example.com", shopifyCustomerId: "888", status: "new" });

    const body = await get("777");

    expect(body.logged_in).toBe(true);
    expect(body.tickets).toEqual([
      {
        id: mine.id,
        status: "in_repair",
        status_label: "In repair",
        product_title: "Boot",
        created_at: mine.createdAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      },
    ]);
  });

  it("carries the cover a repair was raised under, as its storefront badge", async () => {
    const plan = await createCarePlanFor(shop, { name: "Care", shopifyVariantId: "7001", termMonths: 18 });
    const item = await createItemFor(shop, { shopifyCustomerId: "777", productTitle: "Boot", purchasedAt: daysAgo(30) });
    const cover = await createCover(careCoverFor(item, plan));
    await createRepairTicketFor(shop, { shopifyCustomerId: "777", itemId: item.id, coverId: cover.id });

    const json = (await get("777")).tickets[0].cover as Record<string, string>;

    expect([json.kind, json.badge, json.ends_at]).toEqual([
      "care",
      "ShopCare – 18 month plan",
      cover.endsAt.toISOString().slice(0, 10),
    ]);
  });

  it("links a quote awaiting payment to its review page (pay or decline), until it expires", async () => {
    const ticket = await createRepairTicketFor(shop, { shopifyCustomerId: "777", status: "quoted" });
    const quotation = await createQuotationFor(ticket.id, {
      status: "sent",
      shopifyDraftOrderUrl: "https://shop.test/checkout/abc",
    });
    const expires = new Date(Date.now() + 7 * 86_400_000);
    const token = await issueDecisionToken(quotation.id, expires);

    let quote = (await get("777")).tickets[0].quotation as Record<string, string>;
    expect(quote).toEqual({
      status: "sent",
      currency: "GBP",
      subtotal: "0.00",
      review_url: `/apps/repairs/quotes/${token}`,
      expires_at: expires.toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    expect(quote).not.toHaveProperty("checkout_url"); // payment starts from the review page

    await updateQuotation(quotation.id, { decisionExpiresAt: new Date(Date.now() - 60_000) });
    quote = (await get("777")).tickets[0].quotation as Record<string, string>;
    expect(quote).not.toHaveProperty("review_url");
  });

  it("reports not-logged-in when there's no customer id", async () => {
    expect(await get("")).toEqual({ ok: true, logged_in: false, tickets: [] });
  });

  it("rejects an unsigned request", async () => {
    const unsigned = new Request(
      `https://shopcare.test/proxy/status?shop=${domain}&logged_in_customer_id=777&signature=deadbeef`,
    );
    await expect(runRoute(loader, unsigned)).rejects.toMatchObject({ status: 400 });
  });
});
