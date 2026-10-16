/**
 * The ticket page's Item section: Mark received, Resend postage email and
 * the postage slip download, against the real services.
 */
import type { Prisma, RepairTicket, Shop } from "@prisma/client";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { loader as slipLoader } from "../../../app/routes/app.tickets.$id_.postage_slip";
import { action, loader } from "../../../app/routes/app.tickets.$id";
import { setNotificationDeps } from "../../../app/services/notifications.server";
import { flash, get, post, signInAs } from "../../support/admin";
import { createRepairTicketFor, createShop, WORKSHOP_SETTINGS } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";
import { dbNotifyDeps } from "../../support/quotes";

type Detail = Awaited<ReturnType<typeof loader>>;

describe("ticket page: postage", () => {
  let shop: Shop;
  let ticket: RepairTicket;

  async function setup(settings: Record<string, unknown> = { ...WORKSHOP_SETTINGS }, status = "awaiting_item") {
    shop = await createShop({ shopifyDomain: "admin-postage.myshopify.com", settings: settings as Prisma.InputJsonValue });
    signInAs(shop, {
      admin: new FakeGraphql({ "products(": { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } }),
    });
    ticket = await createRepairTicketFor(shop, { status, customerEmail: "sarah@example.com", customerName: "Sarah", productTitle: "Boot" });
  }
  const path = () => `/app/tickets/${ticket.id}`;
  const detail = () => get<Detail>(loader, path(), { id: String(ticket.id) });
  const act = (intent: string) => post(action, path(), { intent }, { id: String(ticket.id) });

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbNotifyDeps();
  });
  afterEach(() => setNotificationDeps(undefined));

  it("shows the Item section's state and actions", async () => {
    await setup();
    expect((await detail()).postage).toEqual({
      awaiting: true,
      receivedAt: null,
      workshopAddress: "Acme Repairs, 4 Cobbler's Yard, Northampton NN1 1AA, United Kingdom",
      emailsSent: 0,
      canMarkReceived: true,
      canResend: true,
      canDownload: true,
    });
  });

  it("prompts for the workshop address when it's missing", async () => {
    await setup({});
    const { postage } = await detail();
    expect([postage.workshopAddress, postage.canDownload]).toEqual([null, false]);
    const res = (await get(slipLoader, `${path()}/postage_slip`, { id: String(ticket.id) })) as Response;
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/Settings → Repairs/);
    expect(flash(await act("resend_postage")).alert).toMatch(/workshop address/);
  });

  it("downloads the postage slip PDF", async () => {
    await setup();
    const res = (await get(slipLoader, `${path()}/postage_slip`, { id: String(ticket.id) })) as Response;
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`attachment; filename="repair-${ticket.id}-postage-slip.pdf"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const doc = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()), { updateMetadata: false });
    expect(doc.getTitle()).toBe(`Repair #${ticket.id} postage slip`);
  });

  it("won't download another shop's slip", async () => {
    await setup();
    const other = await createShop();
    const theirs = await createRepairTicketFor(other, { status: "awaiting_item" });
    const res = (await get(slipLoader, `/app/tickets/${theirs.id}/postage_slip`, { id: String(theirs.id) })) as Response;
    expect(res.status).toBe(404);
  });

  it("Resend postage email queues another email", async () => {
    await setup();
    expect(flash(await act("resend_postage"))).toEqual({ path: path(), notice: "Postage email sent again to sarah@example.com." });
    expect(await prisma.notificationDelivery.count({ where: { event: "item_requested" } })).toBe(1);
    expect((await detail()).postage.emailsSent).toBe(1);
  });

  it("Mark received moves the ticket on and logs it", async () => {
    await setup();
    expect(flash(await act("mark_received"))).toEqual({
      path: path(),
      notice: "Item marked as received. The customer has been told.",
    });
    const data = await detail();
    expect(data.ticket.status).toBe("received");
    expect(data.postage).toMatchObject({ awaiting: false, canMarkReceived: false, canResend: false });
    expect(data.postage.receivedAt).not.toBeNull();
    expect(data.activities[0].body).toBe("Status changed from awaiting_item to received.");
    expect(await prisma.notificationDelivery.count({ where: { event: "item_received" } })).toBe(1);
    expect(flash(await act("mark_received")).alert).toBe("This item is already marked as received.");
  });

  it("an item that turns up before the quote can be marked received", async () => {
    await setup(undefined, "assessing");
    expect((await detail()).postage).toMatchObject({ awaiting: false, canMarkReceived: true, canResend: false });
    expect(flash(await act("mark_received")).notice).toMatch(/marked as received/);
    expect((await detail()).ticket.status).toBe("assessing");
  });
});
