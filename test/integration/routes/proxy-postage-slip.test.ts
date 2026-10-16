/**
 * GET /proxy/tickets/:id/postage-slip: the signed email link (guests too),
 * the logged-in owner, and everyone else; plus the Repair status JSON's link.
 */
import type { RepairTicket, Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { loader as status } from "../../../app/routes/proxy.status";
import { loader } from "../../../app/routes/proxy.tickets.$id.postage-slip";
import { postageSlipKey, postageSlipLink } from "../../../app/services/repairs/postage-slip.server";
import { createRepairTicketFor, WORKSHOP_SETTINGS } from "../../support/factories";
import { fakeStorefront, installedShop, runRoute, signedGet, type StorefrontFakes } from "../../support/proxy-routes";

const domain = "postage-proxy.myshopify.com";

describe("GET /proxy/tickets/:id/postage-slip", () => {
  let shop: Shop;
  let ticket: RepairTicket;
  let fakes: StorefrontFakes;

  beforeEach(async () => {
    shop = await installedShop(domain, { settings: { ...WORKSHOP_SETTINGS } });
    ticket = await createRepairTicketFor(shop, {
      status: "awaiting_item",
      shopifyCustomerId: "77",
      customerEmail: "sarah@example.com",
      customerName: "Sarah",
      productTitle: "Boot",
    });
    fakes = fakeStorefront();
  });
  afterEach(() => fakes.restore());

  /** The query of a signed link, as Shopify forwards it. */
  const linkQuery = (url: string) => Object.fromEntries(new URL(url).searchParams);
  const download = (id: number, { customerId = "", extra = {} }: { customerId?: string; extra?: Record<string, string> } = {}) =>
    runRoute(loader, signedGet(`/proxy/tickets/${id}/postage-slip`, domain, { customerId, extra }), { id: String(id) });

  it("a guest with the emailed link gets the PDF, privately", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { shopifyCustomerId: null } });
    const res = await download(ticket.id, { extra: linkQuery(postageSlipLink(shop, ticket.id)) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="repair-${ticket.id}-postage-slip.pdf"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");
    expect(await fakes.storage.get(postageSlipKey(shop.id, ticket.id))).not.toBeNull();
  });

  it("an expired link asks the customer to log in", async () => {
    const old = postageSlipLink(shop, ticket.id, { now: new Date(Date.now() - 31 * 86_400_000) });
    const res = await download(ticket.id, { extra: linkQuery(old) });
    expect(res.status).toBe(410);
    expect(res.headers.get("Content-Type")).toBe("application/liquid");
    expect(await res.text()).toMatch(/link has expired/);
  });

  it("a tampered link, or another ticket's, is not found", async () => {
    const query = linkQuery(postageSlipLink(shop, ticket.id));
    expect((await download(ticket.id, { extra: { ...query, token: "f".repeat(64) } })).status).toBe(404);
    const other = await createRepairTicketFor(shop, { status: "awaiting_item", shopifyCustomerId: "88" });
    expect((await download(other.id, { extra: query })).status).toBe(404);
    expect((await download(999_999, { extra: query })).status).toBe(404);
  });

  it("the logged-in owner needs no link; another customer gets nothing", async () => {
    expect((await download(ticket.id, { customerId: "77" })).status).toBe(200);
    const res = await download(ticket.id, { customerId: "88" });
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("application/liquid");
    expect((await download(ticket.id)).status).toBe(404); // a guest without a link
  });

  it("only while the ticket awaits its item", async () => {
    await prisma.repairTicket.update({ where: { id: ticket.id }, data: { status: "received", itemReceivedAt: new Date() } });
    const res = await download(ticket.id, { customerId: "77" });
    expect(res.status).toBe(410);
    expect(await res.text()).toMatch(/already received your item/);
  });

  it("says it isn't ready without a workshop address", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: {} } });
    const res = await download(ticket.id, { customerId: "77" });
    expect(res.status).toBe(409);
  });

  it("another shop can't use this shop's link", async () => {
    const other = await installedShop("other-postage.myshopify.com", { settings: { ...WORKSHOP_SETTINGS } });
    const query = linkQuery(postageSlipLink(other, ticket.id));
    expect((await download(ticket.id, { extra: query })).status).toBe(404);
  });

  it("the Repair status JSON links the slip for tickets awaiting their item, and the link works", async () => {
    await createRepairTicketFor(shop, { status: "in_repair", shopifyCustomerId: "77" });
    const body = (await (await runRoute(status, signedGet("/proxy/status", domain, { customerId: "77" }))).json()) as {
      tickets: { id: number; status: string; postage_slip_url?: string }[];
    };
    const awaiting = body.tickets.find((t) => t.id === ticket.id)!;
    expect(awaiting.status).toBe("awaiting_item");
    expect(awaiting.postage_slip_url).toMatch(
      new RegExp(`^/apps/repairs/tickets/${ticket.id}/postage-slip\\?expires=\\d+&token=[0-9a-f]{64}$`),
    );
    expect(body.tickets.find((t) => t.id !== ticket.id)!.postage_slip_url).toBeUndefined();
    const query = Object.fromEntries(new URL(awaiting.postage_slip_url!, "https://x.test").searchParams);
    expect((await download(ticket.id, { extra: query })).status).toBe(200);
  });

  it("no link in the status JSON until the workshop address is set", async () => {
    await prisma.shop.update({ where: { id: shop.id }, data: { settings: {} } });
    const body = (await (await runRoute(status, signedGet("/proxy/status", domain, { customerId: "77" }))).json()) as {
      tickets: { postage_slip_url?: string }[];
    };
    expect(body.tickets[0].postage_slip_url).toBeUndefined();
  });
});
