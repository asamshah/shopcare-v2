/**
 * The ticket workbench: Rails test/integration/admin_smoke_test.rb (tickets
 * half), admin_quotes_test.rb and the ticket half of admin_items_test.rb.
 * Quote sending/revising and status changes are w2-backend services; here
 * they're mocked, and these tests check the admin calls them correctly and
 * shows their outcome.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { issueDecisionToken } from "../../../app/models/quotation.server";
import { declineQuote, expireQuote } from "../../../app/services/quotes/decision.server";
import { resendInvoice } from "../../../app/services/quotes/resend.server";
import { reviseQuote } from "../../../app/services/quotes/revise.server";
import { sendQuote } from "../../../app/services/quotes/send.server";
import { changeTicketStatus } from "../../../app/services/repairs/ticket-status.server";
import { action, loader } from "../../../app/routes/app.tickets.$id";
import { loader as indexLoader } from "../../../app/routes/app.tickets._index";
import { dataOf, flash, get, post, signInAs, statusOf } from "../../support/admin";
import {
  createItemFor,
  createLineItem,
  createQuotationFor,
  createRepairTicketFor,
  createShop,
  createWarrantyCover,
  createWarrantyPolicyFor,
  daysAgo,
} from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

vi.mock("../../../app/services/quotes/send.server", () => ({ sendQuote: vi.fn() }));
vi.mock("../../../app/services/quotes/resend.server", () => ({ resendInvoice: vi.fn() }));
vi.mock("../../../app/services/quotes/revise.server", () => ({ reviseQuote: vi.fn() }));
vi.mock("../../../app/services/quotes/decision.server", () => ({ declineQuote: vi.fn(), expireQuote: vi.fn() }));
vi.mock("../../../app/services/repairs/ticket-status.server", () => ({ changeTicketStatus: vi.fn() }));

type Detail = Awaited<ReturnType<typeof loader>>;
type List = Awaited<ReturnType<typeof indexLoader>>;

async function setup() {
  const shop = await createShop({ shopifyDomain: "admin-test.myshopify.com", settings: { currency: "GBP" } });
  const admin = new FakeGraphql({
    // The quote builder's repair-product list (none configured in these tests).
    "products(": { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
  });
  signInAs(shop, { admin });
  return { shop, admin };
}

const ticketPath = (id: number) => `/app/tickets/${id}`;
const detail = (id: number) => get<Detail>(loader, ticketPath(id), { id: String(id) });
const act = (id: number, fields: Record<string, string>) => post(action, ticketPath(id), fields, { id: String(id) });

beforeEach(() => vi.clearAllMocks());

describe("tickets list", () => {
  it("renders the shop's tickets", async () => {
    const { shop } = await setup();
    await createRepairTicketFor(shop, { status: "new" });
    const data = await get<List>(indexLoader, "/app/tickets");
    expect(data.tickets).toHaveLength(1);
    expect(data.statuses.find((s) => s.status === "new")?.count).toBe(1);
  });

  it("paginates and escapes search wildcards", async () => {
    const { shop } = await setup();
    for (let i = 0; i < 30; i++) await createRepairTicketFor(shop, { customerEmail: `c${i}@example.com`, productTitle: `Boot ${i}` });
    await createRepairTicketFor(shop, { customerEmail: "pct@example.com", productTitle: "100% Wool" });

    const first = await get<List>(indexLoader, "/app/tickets");
    expect(first.tickets).toHaveLength(25);
    expect(first.hasNextPage).toBe(true);
    const second = await get<List>(indexLoader, "/app/tickets?page=2");
    expect(second.page).toBe(2);
    expect(second.tickets).toHaveLength(6);

    const search = await get<List>(indexLoader, "/app/tickets?q=100%25");
    expect(search.tickets.map((t) => t.product)).toEqual(["100% Wool"]);
  });

  it("filters by status", async () => {
    const { shop } = await setup();
    await createRepairTicketFor(shop, { status: "new" });
    await createRepairTicketFor(shop, { status: "ready" });
    const data = await get<List>(indexLoader, "/app/tickets?status=ready");
    expect(data.tickets.map((t) => t.status)).toEqual(["Ready"]);
  });
});

describe("ticket workbench", () => {
  it("renders", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const data = await detail(ticket.id);
    expect(data.ticket.id).toBe(ticket.id);
    expect(data.canEditQuote).toBe(true);
  });

  it("adding a repair product resolves the variant from the catalogue", async () => {
    const { shop } = await setup();
    signInAs(shop, {
      admin: new FakeGraphql({
        "productVariant(": {
          productVariant: {
            id: "gid://shopify/ProductVariant/100",
            title: "Default Title",
            price: "18.00",
            product: { id: "gid://shopify/Product/10", title: "Sole replacement" },
          },
        },
      }),
    });
    const ticket = await createRepairTicketFor(shop);

    const res = await act(ticket.id, { intent: "add_line", kind: "repair", shopify_variant_id: "100", quantity: "1" });

    expect(flash(res)).toEqual({ path: ticketPath(ticket.id), notice: "Line item added." });
    const line = await prisma.quotationLineItem.findFirstOrThrow({ orderBy: { id: "desc" } });
    expect([line.kind, line.shopifyVariantId, line.title, line.unitPrice.toNumber()]).toEqual([
      "repair", "100", "Sole replacement", 18,
    ]);
  });

  it("an unknown repair variant is rejected", async () => {
    const { shop } = await setup();
    signInAs(shop, { admin: new FakeGraphql({ "productVariant(": { productVariant: null } }) });
    const ticket = await createRepairTicketFor(shop);

    const res = await act(ticket.id, { intent: "add_line", kind: "repair", shopify_variant_id: "999" });

    expect(flash(res)).toEqual({ path: ticketPath(ticket.id), alert: "That repair product couldn't be found." });
    expect(await prisma.quotationLineItem.count()).toBe(0);
  });

  it("adding an extra creates a manual line", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    await act(ticket.id, { intent: "add_line", kind: "extra", title: "Lace hook", quantity: "2", unit_price: "5" });
    const line = await prisma.quotationLineItem.findFirstOrThrow();
    expect([line.kind, line.title, line.quantity]).toEqual(["extra", "Lace hook", 2]);
    const quote = await prisma.quotation.findFirstOrThrow();
    expect(quote.subtotal.toNumber()).toBe(10);
  });

  it("an invalid extra shows the model's message", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const res = await act(ticket.id, { intent: "add_line", kind: "extra", title: "", unit_price: "5" });
    expect(flash(res).alert).toBe("Title can't be blank");
  });

  it("line items can't be added to or removed from a sent quote", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, { status: "sent" });
    const line = await createLineItem(quote.id, { title: "Part", unitPrice: 5 });

    expect(flash(await act(ticket.id, { intent: "add_line", kind: "extra", title: "Sneaky", unit_price: "1" })).alert).toBe(
      "This quote has already been sent.",
    );
    expect(flash(await act(ticket.id, { intent: "remove_line", line_id: String(line.id) })).alert).toBe(
      "Line item not found.",
    );
    expect((await prisma.quotationLineItem.findMany()).map((l) => l.title)).toEqual(["Part"]);
  });

  it("a draft line can be removed", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id);
    const line = await createLineItem(quote.id);
    expect(flash(await act(ticket.id, { intent: "remove_line", line_id: String(line.id) })).notice).toBe(
      "Line item removed.",
    );
    expect(await prisma.quotationLineItem.count()).toBe(0);
  });

  it("changing status goes through changeTicketStatus", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    vi.mocked(changeTicketStatus).mockResolvedValue({ ok: true });

    const res = await act(ticket.id, { intent: "status", status: "in_repair" });

    expect(changeTicketStatus).toHaveBeenCalledWith({ shopId: shop.id, ticketId: ticket.id, to: "in_repair", actor: "staff" });
    expect(flash(res).notice).toBe("Status updated to in repair.");
  });

  it("status: the service's message and errors are shown; unknown and unchanged statuses aren't sent", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop, { status: "quoted" });
    vi.mocked(changeTicketStatus).mockResolvedValueOnce({ ok: true, message: "Status updated to cancelled. Quote cancelled." });
    expect(flash(await act(ticket.id, { intent: "status", status: "cancelled" })).notice).toBe(
      "Status updated to cancelled. Quote cancelled.",
    );
    vi.mocked(changeTicketStatus).mockResolvedValueOnce({ ok: false, error: "Can't do that" });
    expect(flash(await act(ticket.id, { intent: "status", status: "new" })).alert).toBe("Can't do that");

    vi.mocked(changeTicketStatus).mockClear();
    expect(flash(await act(ticket.id, { intent: "status", status: "bogus" })).alert).toBe("Unknown status.");
    expect(flash(await act(ticket.id, { intent: "status", status: "quoted" }))).toEqual({ path: ticketPath(ticket.id) });
    expect(changeTicketStatus).not.toHaveBeenCalled();
  });

  it("adding a note appends to the activity log", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    expect(flash(await act(ticket.id, { intent: "note", body: "Looks repairable" })).notice).toBe("Note added.");
    expect(flash(await act(ticket.id, { intent: "note", body: "  " })).alert).toBe("Note can't be blank.");
    const activities = await prisma.ticketActivity.findMany();
    expect(activities.map((a) => [a.activityType, a.body])).toEqual([["note", "Looks repairable"]]);
    expect((await detail(ticket.id)).activities[0].body).toBe("Looks repairable");
  });

  it("malformed input is a 400, an unknown intent too", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    expect(statusOf(await act(ticket.id, { intent: "nope" }))).toBe(400);
    expect(statusOf(await act(ticket.id, { intent: "remove_line", line_id: "1; drop" }))).toBe(404);
    expect(statusOf(await act(ticket.id, { intent: "add_line", kind: "extra", title: "X", quantity: "lots" }))).toBe(400);
  });
});

describe("quote actions", () => {
  it("Send quote calls the sender; the ticket then shows the review link and next actions", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop, { status: "assessing" });
    const quote = await createQuotationFor(ticket.id);
    await createLineItem(quote.id, { title: "Resole", unitPrice: 40 });
    vi.mocked(sendQuote).mockImplementation(async ({ quotationId }) => {
      await prisma.quotation.update({ where: { id: quotationId }, data: { status: "sent", sentAt: new Date() } });
      return { ok: true };
    });

    const res = await act(ticket.id, { intent: "send" });

    expect(sendQuote).toHaveBeenCalledWith({ shopId: shop.id, quotationId: quote.id, actor: "staff" });
    expect(flash(res).notice).toBe("Quote sent: Shopify emailed the customer its invoice.");
    const token = await issueDecisionToken(quote.id, new Date(Date.now() + 86_400_000));
    const data = await detail(ticket.id);
    expect(data.quotation?.decision?.reviewUrl).toBe(`https://admin-test.myshopify.com/apps/repairs/quotes/${token}`);
    expect([data.quotation?.decision?.canResend, data.quotation?.decision?.canRevise]).toEqual([true, true]);
    expect(data.canEditQuote).toBe(false);
  });

  it("a £0 warranty quote completes; nothing to send is refused", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    expect(flash(await act(ticket.id, { intent: "send" })).alert).toBe("Add at least one line item before sending.");
    const quote = await createQuotationFor(ticket.id);
    await createLineItem(quote.id);
    vi.mocked(sendQuote).mockResolvedValue({ ok: true, warranty: true });
    expect(flash(await act(ticket.id, { intent: "send" })).notice).toBe(
      "Warranty quote completed — ticket moved to in repair.",
    );
    vi.mocked(sendQuote).mockResolvedValue({ ok: false, error: "Shopify said no" });
    expect(flash(await act(ticket.id, { intent: "send" })).alert).toBe("Shopify said no");
  });

  it("Resend invoice emails it again", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, { status: "sent", sentAt: new Date() });
    vi.mocked(resendInvoice).mockResolvedValue({ ok: true });
    expect(flash(await act(ticket.id, { intent: "resend" })).notice).toBe("Invoice re-sent to the customer.");
    expect(resendInvoice).toHaveBeenCalledWith({ shopId: shop.id, quotationId: quote.id, actor: "staff" });
  });

  it("resend and revise need a quote", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    expect(flash(await act(ticket.id, { intent: "resend" })).alert).toBe("There's no quote on this ticket.");
    expect(flash(await act(ticket.id, { intent: "revise" })).alert).toBe("There's no quote on this ticket.");
  });

  it("a declined quote shows the reason and can be revised", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, {
      status: "declined",
      sentAt: daysAgo(2),
      decidedAt: daysAgo(1),
      decisionReason: "Too dear",
    });
    const data = await detail(ticket.id);
    expect(data.quotation?.decision?.reason).toBe("Too dear");
    expect(data.quotation?.decision?.decided).toMatch(/^Declined /);
    expect(data.quotation?.decision?.canResend).toBe(false);

    vi.mocked(reviseQuote).mockResolvedValue({ ok: true, newQuotationId: quote.id + 1 });
    expect(flash(await act(ticket.id, { intent: "revise" })).notice).toBe("New draft quote started from the last one.");
    expect(reviseQuote).toHaveBeenCalledWith({ shopId: shop.id, quotationId: quote.id, actor: "staff" });
  });

  it("staff can decline a sent quote on the customer's behalf", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, { status: "sent", sentAt: new Date() });
    expect((await detail(ticket.id)).quotation?.decision?.canDecline).toBe(true);
    vi.mocked(declineQuote).mockResolvedValue({ ok: true });

    const res = await act(ticket.id, { intent: "decline", reason: " Phoned: too dear " });

    expect(declineQuote).toHaveBeenCalledWith({ shopId: shop.id, quotationId: quote.id, reason: "Phoned: too dear", by: "staff" });
    expect(flash(res).notice).toBe("Quote declined on the customer's behalf.");
  });

  it("viewing an overdue quote expires it", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    const quote = await createQuotationFor(ticket.id, {
      status: "sent",
      sentAt: daysAgo(20),
      decisionExpiresAt: new Date(Date.now() - 60_000),
    });
    vi.mocked(expireQuote).mockImplementation(async ({ quotationId }) => {
      await prisma.quotation.update({ where: { id: quotationId }, data: { status: "expired" } });
      return { ok: true };
    });

    const data = await detail(ticket.id);

    expect(expireQuote).toHaveBeenCalledWith({ shopId: shop.id, quotationId: quote.id });
    expect(data.quotation?.status).toBe("expired");
    expect(data.quotation?.decision?.canResend).toBe(true);
  });
});

describe("items and cover on a ticket", () => {
  async function covered() {
    const ctx = await setup();
    const policy = await createWarrantyPolicyFor(ctx.shop, { name: "12-month warranty", months: 12 });
    const item = await createItemFor(ctx.shop, {
      shopifyCustomerId: "777",
      customerEmail: "c@example.com",
      productTitle: "Aria Boot",
      orderName: "#1042",
      purchasedAt: daysAgo(30),
    });
    const cover = await createWarrantyCover(ctx.shop, { item, policy });
    return { ...ctx, item, cover };
  }

  it("linking a ticket to an item applies its cover to the draft quote", async () => {
    const { shop, item, cover } = await covered();
    const ticket = await createRepairTicketFor(shop, { shopifyCustomerId: "777" });
    const quote = await createQuotationFor(ticket.id);
    await createLineItem(quote.id, { title: "Re-glue", unitPrice: 20 });

    expect((await detail(ticket.id)).itemCandidates.map((c) => c.id)).toEqual([item.id]);

    const res = await act(ticket.id, { intent: "link_item", item_id: String(item.id) });

    expect(flash(res).notice).toBe("Ticket linked to item.");
    const linked = await prisma.repairTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect([linked.itemId, linked.coverId, linked.inWarranty]).toEqual([item.id, cover.id, true]);
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quote.id } })).subtotal.toNumber()).toBe(0);

    expect(flash(await act(ticket.id, { intent: "cover", apply: "0" })).notice).toBe("Cover removed from the quote.");
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: quote.id } })).subtotal.toNumber()).toBe(20);

    expect(flash(await act(ticket.id, { intent: "link_item", item_id: "" })).notice).toBe("Ticket unlinked.");
  });

  it("a new quote on a covered ticket starts with the cover applied", async () => {
    const { shop, item, cover } = await covered();
    const ticket = await createRepairTicketFor(shop, { itemId: item.id, coverId: cover.id, inWarranty: true });

    await act(ticket.id, { intent: "add_line", kind: "extra", title: "Re-glue", unit_price: "20" });

    const quote = await prisma.quotation.findFirstOrThrow();
    expect([quote.coverId, quote.subtotal.toNumber()]).toEqual([cover.id, 0]);
  });

  it("cover can only change on a draft quote of a covered ticket", async () => {
    const { shop } = await setup();
    const ticket = await createRepairTicketFor(shop);
    expect(flash(await act(ticket.id, { intent: "cover", apply: "1" })).alert).toBe(
      "There's no draft quote with cover to change.",
    );
  });
});

describe("tenant isolation", () => {
  it("another shop's ticket, item or line can't be seen or changed", async () => {
    const { shop } = await setup();
    const other = await createShop({ shopifyDomain: "other.myshopify.com" });
    const theirs = await createRepairTicketFor(other);
    const theirItem = await createItemFor(other);
    const theirQuote = await createQuotationFor(theirs.id);
    const theirLine = await createLineItem(theirQuote.id);
    const mine = await createRepairTicketFor(shop);
    const myQuote = await createQuotationFor(mine.id);
    void myQuote;

    expect(statusOf(await detail(theirs.id))).toBe(404);
    expect(statusOf(await act(theirs.id, { intent: "note", body: "hi" }))).toBe(404);
    expect(statusOf(await act(mine.id, { intent: "link_item", item_id: String(theirItem.id) }))).toBe(404);
    expect(flash(await act(mine.id, { intent: "remove_line", line_id: String(theirLine.id) })).alert).toBe(
      "Line item not found.",
    );
    expect(await prisma.quotationLineItem.count()).toBe(1);
    expect(await prisma.ticketActivity.count()).toBe(0);
    const list = await get<List>(indexLoader, "/app/tickets");
    expect(list.tickets.map((t) => t.id)).toEqual([mine.id]);
    expect(dataOf<Detail>(await detail(mine.id)).ticket.id).toBe(mine.id);
  });
});
