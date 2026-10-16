/**
 * The admin without Shopify Flow: "Needs attention" on the Tickets home and
 * the customer data request banner / Settings list (ShopCare emails no one).
 */
import type { Prisma, Shop } from "@prisma/client";
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { verifySignedUrl } from "../../../app/lib/storage.server";
import { loader as settingsLoader } from "../../../app/routes/app.settings";
import { loader as indexLoader } from "../../../app/routes/app.tickets._index";
import { ATTENTION_LIMIT, needsAttention } from "../../../app/services/admin/needs-attention.server";
import { get, signInAs } from "../../support/admin";
import { createQuotationFor, createRepairTicketFor, createShop, daysAgo } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

type List = Awaited<ReturnType<typeof indexLoader>>;
type Settings = Awaited<ReturnType<typeof settingsLoader>>;

async function setup(settings: Record<string, unknown> = {}) {
  const shop = await createShop({
    shopifyDomain: "attention.myshopify.com",
    settings: { currency: "GBP", ...settings } as Prisma.InputJsonValue,
  });
  signInAs(shop, { admin: new FakeGraphql({}) });
  return shop;
}

const ticket = (shop: Shop, overrides: Partial<Prisma.RepairTicketUncheckedCreateInput>) =>
  createRepairTicketFor(shop, { customerName: "Sarah", productTitle: "Boot", ...overrides });

describe("needsAttention", () => {
  it("groups what staff should act on, each linking to its ticket", async () => {
    const shop = await setup();
    const fresh = await ticket(shop, { status: "new" });
    const assessing = await ticket(shop, { status: "assessing" });
    const quoted = await ticket(shop, { status: "assessing" });
    await createQuotationFor(quoted.id, { status: "sent" }); // already quoted: not "to quote"
    const declined = await ticket(shop, { status: "quote_declined" });
    await createQuotationFor(declined.id, { status: "declined", decisionReason: "Too dear" });
    const expired = await ticket(shop, { status: "quote_declined" });
    await createQuotationFor(expired.id, { status: "expired", decidedAt: new Date(Date.UTC(2026, 9, 1)) });
    const late = await ticket(shop, { status: "awaiting_item" });
    await createQuotationFor(late.id, { status: "paid", paidAt: daysAgo(20) });
    const recent = await ticket(shop, { status: "awaiting_item" });
    await createQuotationFor(recent.id, { status: "paid", paidAt: daysAgo(3) });
    const received = await ticket(shop, { status: "received", itemReceivedAt: new Date(Date.UTC(2026, 9, 10)) });
    await ticket(shop, { status: "in_repair" });
    await ticket(shop, { status: "completed" });

    const result = await needsAttention(shop);
    expect(result.total).toBe(6);
    expect(result.awaitingItemDays).toBe(14);
    expect(result.groups.map((g) => [g.group, g.label, g.count, g.rows.map((r) => r.ticketId)])).toEqual([
      ["new_requests", "New repair requests to quote", 2, [fresh.id, assessing.id]],
      ["declined", "Quotes declined", 1, [declined.id]],
      ["expired", "Quotes expired", 1, [expired.id]],
      ["awaiting_item", "Paid, item not received", 1, [late.id]],
      ["received", "Received, not started", 1, [received.id]],
    ]);
    const rows = Object.fromEntries(result.groups.map((g) => [g.group, g.rows[0]]));
    expect(rows.declined).toEqual({ ticketId: declined.id, customer: "Sarah", product: "Boot", detail: "Reason: Too dear" });
    expect(rows.expired.detail).toBe("Expired 01 Oct 2026");
    expect(rows.received.detail).toBe("Received 10 Oct 2026");
    expect(rows.awaiting_item.detail).toMatch(/^Paid /);
  });

  it("uses the shop's chase-after days, counts everything and shows at most ATTENTION_LIMIT rows", async () => {
    const shop = await setup({ awaiting_item_days: "2" });
    const recent = await ticket(shop, { status: "awaiting_item" });
    await createQuotationFor(recent.id, { status: "paid", paidAt: daysAgo(3) });
    for (let i = 0; i < ATTENTION_LIMIT + 2; i++) await ticket(shop, { status: "new" });

    const result = await needsAttention(shop);
    const group = (name: string) => result.groups.find((g) => g.group === name)!;
    expect(group("awaiting_item").rows.map((r) => r.ticketId)).toEqual([recent.id]);
    expect([group("new_requests").count, group("new_requests").rows.length]).toEqual([ATTENTION_LIMIT + 2, ATTENTION_LIMIT]);
  });

  it("is empty when nothing needs doing, and ignores other shops", async () => {
    const shop = await setup();
    await ticket(await createShop(), { status: "new" });
    expect(await needsAttention(shop)).toEqual({ total: 0, awaitingItemDays: 14, groups: [] });
  });
});

describe("Tickets home", () => {
  it("shows Needs attention on the unfiltered first page only", async () => {
    const shop = await setup();
    await ticket(shop, { status: "received" });
    const home = await get<List>(indexLoader, "/app/tickets");
    expect(home.attention).toMatchObject({ total: 1, groups: [{ group: "received", count: 1 }] });
    expect((await get<List>(indexLoader, "/app/tickets?status=received")).attention).toBeNull();
    expect((await get<List>(indexLoader, "/app/tickets?q=Boot")).attention).toBeNull();
    expect(home.dataRequests).toBe(0);
  });

  it("flags customer data requests, which Settings lists with a signed download", async () => {
    const key = "gdpr-exports/attention.myshopify.com/9999.json";
    await setup({
      gdpr_exports: [
        {
          key,
          request_id: "9999",
          created_at: "2026-10-16T10:00:00.000Z",
          customer: "a@example.com",
          counts: { tickets: 1, items: 2, tradeIns: 0, deliveries: 3 },
        },
      ],
    });
    expect((await get<List>(indexLoader, "/app/tickets")).dataRequests).toBe(1);
    const settings = await get<Settings>(settingsLoader, "/app/settings");
    expect(settings.dataRequests).toEqual([
      {
        key,
        when: expect.any(String),
        customer: "a@example.com",
        counts: "1 tickets, 2 items, 0 trade-ins, 3 notifications",
        url: expect.stringContaining("/files/"),
      },
    ]);
    expect(verifySignedUrl(new URL(settings.dataRequests[0].url))).toBe(key);
  });
});

describe("Settings → Repairs: chase items after", () => {
  it("saves awaiting_item_days, clamped", async () => {
    const shop = await setup();
    const { action } = await import("../../../app/routes/app.settings");
    const { post } = await import("../../support/admin");
    await post(action, "/app/settings", { awaiting_item_days: "21" });
    const saved = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect((saved.settings as Record<string, unknown>).awaiting_item_days).toBe("21");
    expect((await get<Settings>(settingsLoader, "/app/settings")).awaitingItemDays).toBe(21);
  });
});
