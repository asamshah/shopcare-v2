/**
 * Ported from Rails test/services/notifications/notifications_test.rb: the
 * Flow and Klaviyo channels (ShopCare sends no email itself), idempotency and
 * retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelsFor,
  deliverNotification,
  emitNotification,
  getNotificationDeps,
  idempotencyKey,
  setNotificationDeps,
  type EmitInput,
} from "../../../app/services/notifications.server";
import { DeliveryError } from "../../../app/services/notifications/delivery-error.server";
import type {
  EventData,
  EventName,
} from "../../../app/services/notifications/events.server";
import { notificationJob } from "../../../app/jobs/notification.server";
import { runJob } from "../../../app/jobs/registry.server";
import { FakeGraphql } from "../../support/fake-graphql";
import { buildDeps, buildSettings } from "../../support/notifications";

let ctx: ReturnType<typeof buildDeps>;

beforeEach(() => {
  ctx = buildDeps();
});
afterEach(() => {
  setNotificationDeps(undefined);
});
const careOffer: EventData["care_offer"] = {
  orderId: 1001,
  productTitle: "Boot",
  carePlan: "Care Plus",
  carePrice: 15.0,
  currency: "GBP",
  offerEnds: "2026-11-15",
  addCareUrl: "https://acme.example/add-care",
  customerName: "Sarah",
};

const quoteDeclined: EventData["quote_declined"] = {
  quotationId: 9,
  ticketId: 42,
  productTitle: "Boot",
  customerName: "Sarah",
  customerEmail: "sarah@example.com",
  quoteTotal: "£45.00",
  reason: "No",
};

async function emit<E extends EventName>(
  event: E,
  data: EventData[E],
  input: Partial<EmitInput<E>> = {},
) {
  return emitNotification(
    event,
    {
      settings: ctx.settings.current,
      recipient: { customerId: "77", email: "a@example.com", name: "Sarah" },
      data,
      ...input,
    },
    ctx.deps,
  );
}

async function deliverAll() {
  for (const id of ctx.enqueued.splice(0)) {
    await deliverNotification(id, ctx.deps);
  }
}

describe("channels", () => {
  it("goes nowhere by default: Flow is off and Klaviyo isn't connected", () => {
    expect(channelsFor("care_activated", buildSettings())).toEqual([]);
    expect(channelsFor("quote_paid", buildSettings())).toEqual([]);
  });

  it("goes to Shopify Flow when enabled, and to Klaviyo once connected", () => {
    const settings = buildSettings({ flowEnabled: true });
    expect(channelsFor("care_activated", settings)).toEqual(["flow"]);
    settings.klaviyoApiKey = "pk_test";
    expect(channelsFor("care_activated", settings)).toEqual(["flow", "klaviyo"]);
    settings.flowEnabled = false;
    expect(channelsFor("care_activated", settings)).toEqual(["klaviyo"]);
  });

  it("never sends an email channel", () => {
    const settings = buildSettings({ flowEnabled: true, klaviyoApiKey: "pk" });
    for (const event of ["repair_status_changed", "care_offer", "care_credit_offer", "quote_declined"] as const) {
      expect(channelsFor(event, settings).every((c) => c === "flow" || c === "klaviyo")).toBe(true);
    }
  });
});

function careActivated(): EventData["care_activated"] {
  return {
    coverId: 7,
    carePlan: "Care Plus",
    productTitle: "Boot",
    coverEnds: "2027-10-16",
  };
}

describe("emitNotification", () => {
  it("records a pending delivery per channel and enqueues each", async () => {
    ctx.settings.current = buildSettings({ flowEnabled: true });
    const deliveries = await emit("care_activated", careActivated());

    expect(
      deliveries.map((d) => [d.channel, d.status, d.idempotencyKey]),
    ).toEqual([
      ["flow", "pending", "care_activated:cover_7"],
    ]);
    expect(ctx.enqueued).toEqual(deliveries.map((d) => d.id));
    expect(ctx.graphql.calls).toHaveLength(0);
  });

  it("is idempotent: a repeat of the event enqueues nothing", async () => {
    ctx.settings.current = buildSettings({ flowEnabled: true });
    await emit("care_activated", careActivated());
    await emit("care_activated", careActivated());

    expect(ctx.store.all()).toHaveLength(1);
    expect(ctx.enqueued).toHaveLength(1);
  });

  it("keys status changes by status, so each step notifies once", () => {
    const data = { ticketId: 42, productTitle: "Boot" } as const;
    expect(
      idempotencyKey("repair_status_changed", { ...data, status: "ready" }),
    ).toBe("repair_status_changed:ticket_42:ready");
    expect(
      idempotencyKey("repair_status_changed", { ...data, status: "completed" }),
    ).toBe("repair_status_changed:ticket_42:completed");
  });

  it("rejects unknown events", async () => {
    await expect(
      emit("nope" as EventName, {} as EventData["care_offer"]),
    ).rejects.toThrow(/Unknown notification/);
  });
});

describe("deliverNotification: retries", () => {
  beforeEach(() => {
    ctx.settings.current = buildSettings({ klaviyoApiKey: "pk_test" });
  });

  it("rethrows a retryable error and keeps the delivery pending", async () => {
    vi.mocked(ctx.deps.fetch)
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 202 }));
    const [delivery] = await emit("care_activated", careActivated());

    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow(DeliveryError);
    expect(ctx.store.all()[0]).toMatchObject({ status: "pending", attempts: 1 });

    await deliverNotification(delivery.id, ctx.deps);
    expect(ctx.store.all()[0]).toMatchObject({ status: "sent", error: null });
  });

  it("marks the delivery failed after the last attempt, without throwing", async () => {
    vi.mocked(ctx.deps.fetch).mockResolvedValue(new Response("", { status: 503 }));
    const [delivery] = await emit("care_activated", careActivated());

    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow();
    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow();
    await deliverNotification(delivery.id, ctx.deps);

    expect(ctx.store.all()[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("delivers once, however often the job runs", async () => {
    const [delivery] = await emit("care_activated", careActivated());
    await deliverNotification(delivery.id, ctx.deps);
    await deliverNotification(delivery.id, ctx.deps);
    expect(ctx.deps.fetch).toHaveBeenCalledOnce();
  });

  it("skips everything once the shop is gone", async () => {
    await emit("care_activated", careActivated());
    vi.mocked(ctx.deps.loadSettings).mockResolvedValueOnce(null);
    await deliverAll();
    expect(ctx.store.all()[0].status).toBe("skipped");
  });
});

describe("deliverNotification: Shopify Flow", () => {
  beforeEach(() => {
    ctx.settings.current = buildSettings({ flowEnabled: true });
  });

  it("fires the Flow trigger with the customer and fields", async () => {
    const [delivery] = await emit("care_offer", careOffer);
    await deliverAll();

    expect(delivery.channel).toBe("flow");
    const { variables } = ctx.graphql.calls.at(-1)!;
    expect(variables.handle).toBe("shopcare-care-offer");
    expect(variables.payload).toEqual({
      customer_id: 77,
      "Product title": "Boot",
      "Care plan": "Care Plus",
      "Care price": 15.0,
      "Offer ends": "2026-11-15",
      "Add Care URL": "https://acme.example/add-care",
    });
    await expect(ctx.store.find(delivery.id)).resolves.toMatchObject({
      status: "sent",
    });
  });

  it("accepts a customer GID", async () => {
    await emit("care_activated", careActivated(), {
      recipient: { customerId: "gid://shopify/Customer/77", email: null },
    });
    await deliverAll();
    expect(ctx.graphql.calls.at(-1)!.variables.payload).toMatchObject({
      customer_id: 77,
    });
  });

  it("skips a customer trigger for a guest", async () => {
    await emit("care_activated", careActivated(), {
      recipient: { customerId: null, email: null },
    });
    await deliverAll();

    const flow = ctx.store.all().find((d) => d.channel === "flow")!;
    expect([flow.status, flow.error]).toEqual([
      "skipped",
      "No Shopify customer to attach the trigger to",
    ]);
    expect(ctx.graphql.calls).toHaveLength(0);
  });

  it("fires a staff alert for a guest, without a customer reference", async () => {
    await emit("quote_declined", quoteDeclined, {
      recipient: { customerId: "77", email: null },
    });
    await deliverAll();

    const { variables } = ctx.graphql.calls.at(-1)!;
    expect(variables.handle).toBe("shopcare-quote-declined");
    expect(variables.payload).not.toHaveProperty("customer_id");
    expect(variables.payload).toMatchObject({ Reason: "No" });
    expect(ctx.store.all()[0].status).toBe("sent");
  });

  it("retries Flow user errors", async () => {
    ctx.graphql = new FakeGraphql({
      flowTriggerReceive: {
        flowTriggerReceive: {
          userErrors: [{ field: "handle", message: "Unknown trigger" }],
        },
      },
    });
    vi.mocked(ctx.deps.adminClient).mockResolvedValue(ctx.graphql);
    const [delivery] = await emit("care_activated", careActivated());

    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow(
      DeliveryError,
    );
    expect(ctx.store.all()[0]).toMatchObject({
      status: "pending",
      error: "Unknown trigger",
    });
  });
});

describe("deliverNotification: Klaviyo", () => {
  it("sends the Klaviyo event, and skips channels it can't use", async () => {
    ctx.settings.current = buildSettings({ klaviyoApiKey: "pk_test" });
    const [delivery] = await emit("care_offer", careOffer);
    await deliverAll();

    const fetchMock = vi.mocked(ctx.deps.fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://a.klaviyo.com/api/events");
    const body = JSON.parse(String(init!.body));
    expect(body.data.attributes).toMatchObject({
      unique_id: `shopcare-${delivery.id}`,
      properties: { "Product title": "Boot", "Care price": 15.0 },
      metric: { data: { attributes: { name: "ShopCare Care Offer" } } },
      profile: { data: { attributes: { email: "a@example.com" } } },
    });
    expect(ctx.store.all()[0].status).toBe("sent");

    await emit(
      "care_offer",
      { ...careOffer, orderId: 2 },
      { recipient: { customerId: null, email: null } },
    );
    await deliverAll();
    expect(ctx.store.all()[1]).toMatchObject({
      status: "skipped",
      error: "No customer email",
    });
  });
});

describe("notification job", () => {
  it("is registered and runs a delivery with the configured deps", async () => {
    setNotificationDeps(ctx.deps);
    ctx.settings.current = buildSettings({ flowEnabled: true });
    expect(getNotificationDeps()).toBe(ctx.deps);
    const [delivery] = await emit("care_activated", careActivated());

    await runJob("notification", { deliveryId: delivery.id });
    expect(ctx.graphql.calls).toHaveLength(1);
    expect(ctx.store.all()[0].status).toBe("sent");
  });

  it("refuses to run before it's wired up", async () => {
    await expect(notificationJob({ deliveryId: "1" })).rejects.toThrow(
      /setNotificationDeps/,
    );
  });

  it("ignores a payload without a delivery id", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await notificationJob({});
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
