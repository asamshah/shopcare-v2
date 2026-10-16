/** Port of Rails test/integration/proxy_status_test.rb (GET /proxy/status). */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
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
      steps: string[];
      care_credits: Record<string, string>[];
      tickets: Record<string, never>[];
    };

  it("shows each repair's step, since ShopCare sends no status emails", async () => {
    const statuses = ["new", "quoted", "awaiting_item", "received", "in_repair", "ready", "completed", "cancelled"];
    for (const status of statuses) await createRepairTicketFor(shop, { shopifyCustomerId: "777", status });
    const body = await get("777");
    expect(body.steps).toEqual(["Requested", "Quoted", "Awaiting item", "Received", "In repair", "Returned"]);
    const byStatus = Object.fromEntries(body.tickets.map((t) => [t.status, (t as Record<string, unknown>).step ?? null]));
    expect(byStatus).toEqual({
      new: 0,
      quoted: 1,
      awaiting_item: 2,
      received: 3,
      in_repair: 4,
      ready: 4,
      completed: 5,
      cancelled: null,
    });
  });

  it("lists the customer's unexpired Care credit codes (ShopCare doesn't email them)", async () => {
    const plan = await createCarePlanFor(shop, { name: "Care", shopifyVariantId: "7001" });
    const item = await createItemFor(shop, { shopifyCustomerId: "777", productTitle: "Boot", purchasedAt: daysAgo(30) });
    const cover = await createCover(careCoverFor(item, plan));
    await prisma.careCredit.create({
      data: { shopId: shop.id, coverId: cover.id, code: "CARE-7XK2", amount: 15, expiresAt: new Date(Date.UTC(2099, 0, 14)) },
    });
    const otherItem = await createItemFor(shop, { shopifyCustomerId: "888", productTitle: "Shoe", purchasedAt: daysAgo(30) });
    const otherCover = await createCover(careCoverFor(otherItem, plan));
    await prisma.careCredit.create({ data: { shopId: shop.id, coverId: otherCover.id, code: "CARE-OTHER", amount: 15 } });
    const oldItem = await createItemFor(shop, { shopifyCustomerId: "777", productTitle: "Old", purchasedAt: daysAgo(30) });
    const oldCover = await createCover(careCoverFor(oldItem, plan));
    await prisma.careCredit.create({ data: { shopId: shop.id, coverId: oldCover.id, code: "CARE-OLD", amount: 9, expiresAt: daysAgo(1) } });

    expect((await get("777")).care_credits).toEqual([
      { code: "CARE-7XK2", amount: "15.00", currency: "GBP", expires_at: "2099-01-14", product_title: "Boot" },
    ]);
    expect((await get("999")).care_credits).toEqual([]);
  });

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
        step: 4,
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
    expect(await get("")).toEqual({ ok: true, logged_in: false, tickets: [], care_credits: [] });
  });

  it("rejects an unsigned request", async () => {
    const unsigned = new Request(
      `https://shopcare.test/proxy/status?shop=${domain}&logged_in_customer_id=777&signature=deadbeef`,
    );
    await expect(runRoute(loader, unsigned)).rejects.toMatchObject({ status: 400 });
  });
});
