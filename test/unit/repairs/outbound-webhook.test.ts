/**
 * Ported from Rails test/jobs/outbound_webhook_job_test.rb and
 * test/services/repairs/event_payload_test.rb.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitOutboundWebhook,
  outboundWebhookJob,
  performOutboundWebhook,
  setOutboundWebhookDeps,
  type OutboundWebhookContext,
} from "../../../app/jobs/outbound-webhook.server";
import { runJob } from "../../../app/jobs/registry.server";
import { buildRepairEventPayload } from "../../../app/services/repairs/event-payload.server";
import type { Transport } from "../../../app/services/repairs/webhook-delivery.server";

const ticket = {
  id: 5,
  status: "in_repair",
  customerEmail: "c@example.com",
  customerName: "Sam",
  productTitle: "Boot",
  orderNumber: "#1",
  inWarranty: false,
  createdAt: new Date("2026-10-01T09:00:00.123Z"),
  updatedAt: new Date("2026-10-02T10:30:00Z"),
};

function context(
  overrides: Partial<OutboundWebhookContext> = {},
): OutboundWebhookContext {
  return {
    url: "https://example.com/hook",
    secret: "s",
    shopDomain: "wh.myshopify.com",
    ticket,
    ...overrides,
  };
}

afterEach(() => setOutboundWebhookDeps(undefined));

describe("emitOutboundWebhook", () => {
  const job = { shopId: "1", ticketId: "5", event: "submitted" };

  it("enqueues when a webhook url is configured", async () => {
    const enqueue = vi.fn(async () => {});
    expect(
      await emitOutboundWebhook("https://example.com/hook", job, enqueue),
    ).toBe(true);
    expect(enqueue).toHaveBeenCalledWith("outbound-webhook", job);
  });

  it("is a no-op when no webhook url is set", async () => {
    const enqueue = vi.fn(async () => {});
    expect(await emitOutboundWebhook("", job, enqueue)).toBe(false);
    expect(await emitOutboundWebhook(null, job, enqueue)).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("performOutboundWebhook", () => {
  it("delivers the built payload, signed", async () => {
    const transport = vi.fn<Transport>(async () => ({ status: 200 }));
    await performOutboundWebhook(
      { shopId: "1", ticketId: "5", event: "payment" },
      {
        loadContext: async () => context(),
        delivery: { strict: false, transport },
      },
    );

    const request = transport.mock.calls[0][0];
    expect(JSON.parse(request.body)).toMatchObject({
      event: "payment",
      shop: "wh.myshopify.com",
      ticket: { id: 5, status: "in_repair" },
    });
    expect(request.headers["X-Repairs-Hmac-Sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("no-ops if the shop's webhook was cleared after enqueue, or the ticket is gone", async () => {
    const transport = vi.fn<Transport>();
    const run = (loaded: OutboundWebhookContext | null) =>
      performOutboundWebhook(
        { shopId: "1", ticketId: "5", event: "submitted" },
        {
          loadContext: async () => loaded,
          delivery: { strict: false, transport },
        },
      );

    expect(await run(context({ url: "" }))).toBeNull();
    expect(await run(null)).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("is registered as a background job using the configured deps", async () => {
    const transport = vi.fn<Transport>(async () => ({ status: 200 }));
    const loadContext = vi.fn(async () => context());
    setOutboundWebhookDeps({
      loadContext,
      delivery: { strict: false, transport },
    });

    await runJob("outbound-webhook", {
      shopId: 1,
      ticketId: 5,
      event: "status_change",
      detail: "ready",
    });

    expect(loadContext).toHaveBeenCalledWith("1", "5");
    expect(JSON.parse(transport.mock.calls[0][0].body)).toMatchObject({
      event: "status_change",
      detail: "ready",
    });
  });

  it("refuses to run before it's wired up", async () => {
    await expect(
      outboundWebhookJob({ shopId: "1", ticketId: "5", event: "x" }),
    ).rejects.toThrow(/setOutboundWebhookDeps/);
  });
});

describe("buildRepairEventPayload", () => {
  it("includes shop, ticket and quotation details", () => {
    const payload = buildRepairEventPayload({
      shopDomain: "ep-test.myshopify.com",
      ticket: { ...ticket, status: "quoted" },
      quotation: {
        status: "declined",
        currency: "GBP",
        subtotal: "20",
        decidedAt: new Date("2026-10-03T12:00:00Z"),
        decidedBy: "customer",
        decisionReason: "Too dear",
      },
      event: "quote_sent",
      detail: "info",
    });

    expect(payload).toMatchObject({
      event: "quote_sent",
      detail: "info",
      shop: "ep-test.myshopify.com",
      ticket: {
        id: 5,
        status: "quoted",
        created_at: "2026-10-01T09:00:00Z",
        updated_at: "2026-10-02T10:30:00Z",
      },
      quotation: {
        subtotal: "20.00",
        currency: "GBP",
        decided_by: "customer",
        decision_reason: "Too dear",
        decided_at: "2026-10-03T12:00:00Z",
      },
    });
    expect(payload.quotation).not.toHaveProperty("expires_at");
  });

  it("omits the quotation and detail keys when there are none", () => {
    const payload = buildRepairEventPayload({
      shopDomain: "ep-test.myshopify.com",
      ticket: { id: 5, status: "new" },
      event: "submitted",
    });

    expect(payload).not.toHaveProperty("quotation");
    expect(payload).not.toHaveProperty("detail");
    // Ticket keys stay present (as null), like Rails.
    expect(payload.ticket).toHaveProperty("order_number", null);
  });
});
