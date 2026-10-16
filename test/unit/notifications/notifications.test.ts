/**
 * Ported from Rails test/services/notifications/notifications_test.rb, plus
 * the v2 email channel: toggles, consent gating, idempotency and retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EmailDeliveryError,
  setEmailAdapter,
} from "../../../app/services/email.server";
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
  setEmailAdapter(undefined);
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
  it("goes to Shopify Flow when enabled, and to Klaviyo once connected", () => {
    const settings = buildSettings({ flowEnabled: true });
    expect(channelsFor("care_activated", careActivated(), settings)).toEqual([
      "email",
      "flow",
    ]);
    settings.klaviyoApiKey = "pk_test";
    expect(channelsFor("care_activated", careActivated(), settings)).toEqual([
      "email",
      "flow",
      "klaviyo",
    ]);
    settings.flowEnabled = false;
    settings.emails = { care_welcome: { enabled: false } };
    expect(channelsFor("care_activated", careActivated(), settings)).toEqual([
      "klaviyo",
    ]);
  });

  it("sends a repair request to the customer and to staff, with no Flow or Klaviyo", () => {
    const settings = buildSettings({ flowEnabled: true, klaviyoApiKey: "pk" });
    expect(
      channelsFor(
        "repair_submitted",
        { ticketId: 1, productTitle: "Boot" },
        settings,
      ),
    ).toEqual(["email", "staff_email"]);
  });

  it("emails customers only for the statuses they care about", () => {
    const settings = buildSettings({ flowEnabled: true });
    const status = (s: EventData["repair_status_changed"]["status"]) =>
      channelsFor(
        "repair_status_changed",
        { ticketId: 1, status: s, productTitle: "Boot" },
        settings,
      );
    expect(status("ready")).toEqual(["email", "flow"]);
    expect(status("completed")).toEqual(["email", "flow"]);
    expect(status("quoted")).toEqual(["flow"]);
  });

  it("keeps the marketing email off until the merchant turns it on", () => {
    expect(channelsFor("care_offer", careOffer, buildSettings())).toEqual([]);
    expect(
      channelsFor(
        "care_offer",
        careOffer,
        buildSettings({ emails: { care_offer: { enabled: true } } }),
      ),
    ).toEqual(["email"]);
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
      ["email", "pending", "care_activated:cover_7"],
      ["flow", "pending", "care_activated:cover_7"],
    ]);
    expect(ctx.enqueued).toEqual(deliveries.map((d) => d.id));
    expect(ctx.email.sent).toHaveLength(0);
  });

  it("is idempotent: a repeat of the event enqueues nothing", async () => {
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

describe("deliverNotification: email", () => {
  it("sends from the store via ShopCare, replying to the merchant", async () => {
    await emit("care_activated", careActivated());
    await deliverAll();

    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]).toMatchObject({
      from: '"Acme Boots via ShopCare" <notifications@mail.shopcare.test>',
      to: ["a@example.com"],
      replyTo: "help@acme.example",
      subject: "Your Care Plus for Boot has started",
      idempotencyKey: "acme.myshopify.com:email:care_activated:cover_7",
      tags: { event: "care_activated", email: "care_welcome" },
    });
    expect(ctx.store.all()[0]).toMatchObject({
      status: "sent",
      providerMessageId: "log_1",
    });
  });

  it("sends staff alerts to 'Notify staff at', replying to the customer", async () => {
    ctx.settings.current = buildSettings({
      staffEmail: "a@acme.example, b@acme.example",
    });
    await emit("quote_declined", quoteDeclined, {
      recipient: { customerId: null, email: null },
    });
    await deliverAll();

    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]).toMatchObject({
      to: ["a@acme.example", "b@acme.example"],
      replyTo: "sarah@example.com",
      subject: "Quote declined for repair #42",
    });
    expect(ctx.email.sent[0].text).toContain("Reason:         No");
  });

  it("skips a staff alert when no staff address is set", async () => {
    ctx.settings.current = buildSettings({ staffEmail: null });
    await emit("quote_declined", quoteDeclined);
    await deliverAll();

    expect(ctx.email.sent).toHaveLength(0);
    expect(ctx.store.all()[0]).toMatchObject({
      status: "skipped",
      error: "No staff alert address in Settings",
    });
  });

  it("re-checks the toggle at send time", async () => {
    await emit("care_activated", careActivated());
    ctx.settings.current = buildSettings({
      emails: { care_welcome: { enabled: false } },
    });
    await deliverAll();

    expect(ctx.email.sent).toHaveLength(0);
    expect(ctx.store.all()[0]).toMatchObject({
      status: "skipped",
      error: "Turned off in Settings",
    });
  });

  it("skips a customer email with no address", async () => {
    await emit("care_activated", careActivated(), {
      recipient: { customerId: "77", email: null },
    });
    await deliverAll();
    expect(ctx.store.all()[0]).toMatchObject({
      status: "skipped",
      error: "No customer email",
    });
  });

  it("delivers once, however often the job runs", async () => {
    const [delivery] = await emit("care_activated", careActivated());
    await deliverNotification(delivery.id, ctx.deps);
    await deliverNotification(delivery.id, ctx.deps);
    expect(ctx.email.sent).toHaveLength(1);
  });

  it("skips everything once the shop is gone", async () => {
    await emit("care_activated", careActivated());
    vi.mocked(ctx.deps.loadSettings).mockResolvedValueOnce(null);
    await deliverAll();
    expect(ctx.store.all()[0].status).toBe("skipped");
  });
});

describe("deliverNotification: marketing consent", () => {
  beforeEach(() => {
    ctx.settings.current = buildSettings({
      emails: { care_offer: { enabled: true } },
    });
  });

  it("sends to a subscribed customer, with one-click unsubscribe headers", async () => {
    await emit("care_offer", careOffer);
    await deliverAll();

    expect(ctx.deps.hasEmailMarketingConsent).toHaveBeenCalledWith(
      { customerId: "77", email: "a@example.com", name: "Sarah" },
      { shopId: "acme.myshopify.com" },
    );
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0].headers).toEqual({
      "List-Unsubscribe": "<https://shopcare.test/unsubscribe?token=abc>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(ctx.email.sent[0].html).toContain("Unsubscribe</a>");
  });

  it("skips a customer who isn't subscribed", async () => {
    vi.mocked(ctx.deps.hasEmailMarketingConsent).mockResolvedValue(false);
    await emit("care_offer", careOffer);
    await deliverAll();

    expect(ctx.email.sent).toHaveLength(0);
    expect(ctx.store.all()[0]).toMatchObject({
      status: "skipped",
      error: "Customer isn't subscribed to email marketing",
    });
  });

  it("always skips guests, without asking Shopify", async () => {
    await emit("care_offer", careOffer, {
      recipient: { customerId: null, email: "guest@example.com" },
    });
    await deliverAll();

    expect(ctx.deps.hasEmailMarketingConsent).not.toHaveBeenCalled();
    expect(ctx.store.all()[0]).toMatchObject({
      status: "skipped",
      error: "Guest customer: no email marketing consent",
    });
  });

  it("skips when no unsubscribe link can be made", async () => {
    ctx.deps.unsubscribeUrl = () => null;
    await emit("care_offer", careOffer);
    await deliverAll();
    expect(ctx.store.all()[0].error).toBe("No unsubscribe link available");
  });

  it("never asks for consent for transactional email", async () => {
    await emit("care_activated", careActivated());
    await deliverAll();
    expect(ctx.deps.hasEmailMarketingConsent).not.toHaveBeenCalled();
    expect(ctx.email.sent[0].headers).toBeUndefined();
  });
});

describe("deliverNotification: retries", () => {
  it("rethrows a retryable error and keeps the delivery pending", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new EmailDeliveryError("Resend 503", true))
      .mockResolvedValueOnce({ id: "re_1" });
    ctx.deps.sendEmail = send;
    const [delivery] = await emit("care_activated", careActivated());

    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow(
      "Resend 503",
    );
    expect(ctx.store.all()[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Resend 503",
    });

    await deliverNotification(delivery.id, ctx.deps);
    expect(ctx.store.all()[0]).toMatchObject({
      status: "sent",
      providerMessageId: "re_1",
      error: null,
    });
    // The same provider idempotency key on the retry.
    expect(send.mock.calls[0][0].idempotencyKey).toBe(
      send.mock.calls[1][0].idempotencyKey,
    );
  });

  it("marks the delivery failed after the last attempt, without throwing", async () => {
    ctx.deps.sendEmail = vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError("Resend 503", true));
    const [delivery] = await emit("care_activated", careActivated());

    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow();
    await expect(deliverNotification(delivery.id, ctx.deps)).rejects.toThrow();
    await deliverNotification(delivery.id, ctx.deps);

    expect(ctx.store.all()[0]).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("fails a permanent error at once", async () => {
    ctx.deps.sendEmail = vi
      .fn()
      .mockRejectedValue(new EmailDeliveryError("invalid address", false));
    const [delivery] = await emit("care_activated", careActivated());

    await deliverNotification(delivery.id, ctx.deps);
    expect(ctx.store.all()[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "invalid address",
    });
  });
});

describe("deliverNotification: Shopify Flow", () => {
  beforeEach(() => {
    ctx.settings.current = buildSettings({ flowEnabled: true });
  });

  it("fires the Flow trigger with the customer and fields", async () => {
    ctx.settings.current.emails = { care_offer: { enabled: false } };
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
    ctx.settings.current.emails = { staff_quote_declined: { enabled: false } };
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
    ctx.settings.current.emails = { care_welcome: { enabled: false } };
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
    ctx.settings.current.emails = { care_offer: { enabled: false } };
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
    expect(getNotificationDeps()).toBe(ctx.deps);
    const [delivery] = await emit("care_activated", careActivated());

    await runJob("notification", { deliveryId: delivery.id });
    expect(ctx.email.sent).toHaveLength(1);
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
