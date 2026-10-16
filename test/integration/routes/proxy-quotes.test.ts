/**
 * Port of Rails test/integration/proxy_quotes_test.rb: the quote review page
 * (GET /proxy/quotes/:token) and decline (POST …/decline).
 *
 * Declining and expiring belong to w2-backend's quote decision service
 * (app/services/quotes/decision.server.ts). The page is tested against a
 * stand-in with Repairs::QuoteDecision's rules, so these tests pin the
 * route's side of the contract: who it calls, with what, and what it renders.
 */
import type { Quotation, RepairTicket, Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import {
  cancelQuotation,
  isDecisionOverdue,
  issueDecisionToken,
  recalculateSubtotal,
  updateQuotation,
} from "../../../app/models/quotation.server";
import { proxyUrl } from "../../../app/models/shop.server";
import { loader as show } from "../../../app/routes/proxy.quotes.$token";
import { action as decline } from "../../../app/routes/proxy.quotes.$token_.decline";
import type { StorefrontDeps } from "../../../app/services/storefront/deps.server";
import {
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
} from "../../support/factories";
import {
  fakeStorefront,
  installedShop,
  runRoute,
  signedGet,
  signedPost,
  type StorefrontFakes,
} from "../../support/proxy-routes";

const domain = "quotes-test.myshopify.com";

/** Repairs::QuoteDecision's rules, as w2-backend's service implements them. */
function decisionStandIn(calls: unknown[][]): Pick<StorefrontDeps, "declineQuote" | "expireQuote"> {
  const close = async (quotation: Quotation, status: string, reason: string | null, by: string) => {
    await prisma.quotation.update({
      where: { id: quotation.id },
      data: { status, decidedAt: new Date(), decidedBy: by, decisionReason: reason },
    });
    await prisma.repairTicket.update({ where: { id: quotation.repairTicketId }, data: { status: "quote_declined" } });
    calls.push(["delete", quotation.shopifyDraftOrderId]);
  };
  const expireQuote: StorefrontDeps["expireQuote"] = async ({ quotationId }) => {
    calls.push(["expire", quotationId]);
    const quotation = await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    if (!isDecisionOverdue(quotation)) return { ok: false, error: "This quote hasn't expired." };
    await close(quotation, "expired", null, "system");
    return { ok: true };
  };
  return {
    expireQuote,
    async declineQuote({ shopId, quotationId, reason, by }) {
      calls.push(["decline", shopId, quotationId, reason, by]);
      const quotation = await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } });
      if (isDecisionOverdue(quotation)) {
        await expireQuote({ shopId, quotationId });
        return { ok: false, error: "This quote has expired." };
      }
      if (quotation.status !== "sent") {
        const refusal: Record<string, string> = {
          expired: "This quote has expired.",
          paid: "This quote has already been paid.",
          declined: "This quote has already been declined.",
        };
        return { ok: false, error: refusal[quotation.status] ?? "This quote can't be changed any more." };
      }
      await close(quotation, "declined", reason?.trim() || null, by);
      return { ok: true };
    },
  };
}

describe("quote review page (App Proxy)", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let quotation: Quotation;
  let token: string;
  let calls: unknown[][];
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { currency: "GBP" } });
    ticket = await createRepairTicketFor(shop, {
      customerEmail: "guest@example.com",
      productTitle: "Boot {{ shop.name }}",
      status: "quoted",
    });
    quotation = await createQuotationFor(ticket.id, {
      status: "sent",
      shopifyDraftOrderId: "999",
      shopifyDraftOrderUrl: "https://shop.test/invoice/abc",
      sentAt: new Date(),
    });
    await createLineItem(quotation.id, { kind: "repair", title: "Sole replacement", unitPrice: 24 });
    quotation = await recalculateSubtotal(quotation.id);
    token = await issueDecisionToken(quotation.id, new Date(Date.now() + 14 * 86_400_000));
    quotation = await prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });
    calls = [];
    fakes = fakeStorefront({}, decisionStandIn(calls));
  });
  afterEach(() => fakes.restore());

  const getPage = (t = token, extra: Record<string, string> = {}, shopDomain = domain) =>
    runRoute(show, signedGet(`/proxy/quotes/${t}`, shopDomain, { extra }), { token: t });
  const postDecline = (fields: Record<string, string> = {}, t = token) =>
    runRoute(decline, signedPost(`/proxy/quotes/${t}/decline`, domain, fields), { token: t });
  const reload = () => prisma.quotation.findUniqueOrThrow({ where: { id: quotation.id } });

  it("a guest sees the review page as Liquid in the theme: lines, total, expiry, Pay now and Decline", async () => {
    const response = await getPage();
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/liquid");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(html).toContain("Sole replacement");
    expect(html).toContain("£24.00");
    const day = quotation.decisionExpiresAt!;
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const validUntil = `${day.getUTCDate()} ${months[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
    expect(html).toContain(`This quote is valid until <strong>${validUntil}</strong>. Pay to accept`);
    expect(html).toContain('href="https://shop.test/invoice/abc"');
    expect(html).toContain(`action="/apps/repairs/quotes/${token}/decline"`);
    expect(html).not.toContain("/accept");
    expect(html).not.toContain("{% layout none %}"); // inside the theme layout
  });

  it("customer text can't run as Liquid or HTML", async () => {
    await prisma.quotationLineItem.updateMany({
      where: { quotationId: quotation.id },
      data: { title: "<script>x</script>{% render 'x' %}" },
    });

    const html = await (await getPage()).text();

    expect(html).not.toContain("{{");
    expect(html).not.toContain("{%");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Boot &#123;&#123; shop.name &#125;&#125;");
  });

  it("declining records the optional reason", async () => {
    const response = await postDecline({ reason: "Found a cobbler nearby" });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(calls[0]).toEqual(["decline", shop.id, quotation.id, "Found a cobbler nearby", "customer"]);
    const after = await reload();
    expect([after.status, after.decisionReason]).toEqual(["declined", "Found a cobbler nearby"]);
    expect((await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe("quote_declined");
    expect(html).toContain("You declined this quote");
    expect(html).not.toContain("Pay now");
    expect(calls.at(-1)).toEqual(["delete", "999"]); // the invoice can't be paid any more
  });

  it("a used link can't decline again", async () => {
    await postDecline();
    const html = await (await postDecline()).text();

    expect(html).toContain("already been declined");
    expect(html).toContain('role="alert"');
    expect((await reload()).status).toBe("declined");
    expect(calls.filter((c) => c[0] === "delete")).toHaveLength(1);
  });

  it("an expired link is refused and the quote expires", async () => {
    await updateQuotation(quotation.id, { decisionExpiresAt: new Date(Date.now() - 60_000) });

    const html = await (await postDecline()).text();

    expect(html).toContain("This quote has expired.");
    expect((await reload()).status).toBe("expired");
  });

  it("opening an overdue quote expires it and deletes its draft order", async () => {
    await updateQuotation(quotation.id, { decisionExpiresAt: new Date(Date.now() - 60_000) });

    const html = await (await getPage()).text();

    expect(html).toContain("This quote expired on");
    expect(calls[0]).toEqual(["expire", quotation.id]);
    expect((await reload()).status).toBe("expired");
    expect(calls.at(-1)).toEqual(["delete", "999"]);
  });

  it("a wrong, revoked or other shop's token finds nothing", async () => {
    let response = await getPage(`${token}x`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Quote not found");

    await installedShop("quotes-other.myshopify.com");
    response = await getPage(token, {}, "quotes-other.myshopify.com");
    expect(response.status).toBe(404);

    response = await getPage("not a token!");
    expect(response.status).toBe(404);

    await cancelQuotation(quotation.id);
    response = await postDecline();
    expect(response.status).toBe(404);
    expect((await reload()).status).toBe("cancelled");
    expect(calls).toEqual([]);
  });

  it("rejects an unsigned request", async () => {
    const unsigned = new Request(`https://shopcare.test/proxy/quotes/${token}?shop=${domain}&signature=deadbeef`);
    await expect(runRoute(show, unsigned, { token })).rejects.toMatchObject({ status: 400 });
  });

  it("remembers a changed proxy path for the links it sends", async () => {
    const html = await (await getPage(token, { path_prefix: "/apps/fix" })).text();

    const row = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(proxyUrl(row, "quotes/abc")).toBe("https://quotes-test.myshopify.com/apps/fix/quotes/abc");
    expect(html).toContain(`action="/apps/fix/quotes/${token}/decline"`);
  });

  it("opens the decline form when linked with choice=decline", async () => {
    const html = await (await getPage(token, { choice: "decline" })).text();
    expect(html).toContain("<details open>");
  });
});
