/**
 * Flow trigger payload parity with the extension TOMLs, the Flow and Klaviyo
 * clients, and the Shopify-backed marketing consent check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { shopifyMarketingConsent } from "../../../app/services/notifications/consent.server";
import { DeliveryError } from "../../../app/services/notifications/delivery-error.server";
import {
  EVENTS,
  type EventData,
  type EventName,
  type RepairStatus,
} from "../../../app/services/notifications/events.server";
import { FlowClient } from "../../../app/services/notifications/flow-client.server";
import { CUSTOMER_MARKETING_CONSENT_QUERY } from "../../../app/shopify/customers.server";
import {
  InvalidFlowCustomerIdError,
  flowCustomerId,
  flowPayload,
} from "../../../app/shopify/flow.server";
import {
  KLAVIYO_REVISION,
  KlaviyoClient,
} from "../../../app/services/notifications/klaviyo-client.server";
import { FakeGraphql } from "../../support/fake-graphql";

const ROOT = join(__dirname, "../../..");

function triggerToml(handle: string): string {
  const dir = `shopcare-flow-${handle.replace(/^shopcare-/, "")}`;
  const path = [
    join(ROOT, "extensions", dir, "shopify.extension.toml"),
    join(ROOT, "parked", dir, "shopify.extension.toml"),
  ].find(existsSync);
  if (!path) throw new Error(`No extension TOML for Flow trigger ${handle}`);
  return readFileSync(path, "utf8");
}

/** Same approach as the Rails test: the `key = "…"` lines of [[settings.fields]]. */
function declaredFields(toml: string) {
  return {
    handle: toml.match(/^handle = "(.+)"$/m)?.[1],
    keys: [...toml.matchAll(/^\s*key = "(.+)"$/gm)].map((m) => m[1]),
    customerReference: /type = "customer_reference"/.test(toml),
    types: Object.fromEntries(
      [...toml.matchAll(/type = "([a-z_]+)"\s*\n\s*key = "(.+)"/g)].map((m) => [
        m[2],
        m[1],
      ]),
    ),
  };
}

const samples: { [E in EventName]: EventData[E] } = {
  repair_submitted: { ticketId: 1, productTitle: "Boot" },
  repair_status_changed: {
    ticketId: 1,
    status: "in_repair",
    productTitle: "Boot",
  },
  item_requested: {
    ticketId: 1,
    productTitle: "Boot",
    workshopAddress: ["Workshop"],
    instructions: "Post it",
    sendNumber: 1,
  },
  item_received: { ticketId: 1, productTitle: "Boot" },
  care_activated: {
    coverId: 1,
    carePlan: "Care",
    productTitle: "Boot",
    coverEnds: "2027-01-01",
  },
  care_credit_offer: {
    coverId: 1,
    carePlan: "Care",
    productTitle: "Boot",
    creditCode: "C1",
    creditAmount: 15,
    currency: "GBP",
    creditExpires: "",
  },
  care_offer: {
    orderId: 1,
    productTitle: "Boot",
    carePlan: "Care",
    carePrice: 15,
    currency: "GBP",
    offerEnds: "2026-11-01",
    addCareUrl: "",
  },
  quote_paid: {
    quotationId: 1,
    ticketId: 1,
    productTitle: "Boot",
    customerName: "Sam",
    customerEmail: "s@example.com",
    quoteTotal: "£1.00",
    orderName: "#1001",
  },
  quote_declined: {
    quotationId: 1,
    ticketId: 1,
    productTitle: "Boot",
    customerName: "Sam",
    customerEmail: "s@example.com",
    quoteTotal: "£1.00",
    reason: "No",
  },
  quote_expired: {
    quotationId: 1,
    ticketId: 1,
    productTitle: "Boot",
    customerName: "Sam",
    customerEmail: "s@example.com",
    quoteTotal: "£1.00",
    validUntil: "2026-10-01",
  },
  trade_in_status_changed: {
    tradeInId: 1,
    status: "approved",
    productTitle: "Boot",
    credit: 20,
    instructions: "Post it",
    creditCode: "",
  },
};

const flowEvents = (Object.keys(EVENTS) as EventName[]).filter(
  (event) => EVENTS[event].flowHandle,
);

describe("Flow trigger payloads match the extension TOMLs", () => {
  it("covers every Rails trigger", () => {
    expect(flowEvents.map((e) => EVENTS[e].flowHandle).sort()).toEqual([
      "shopcare-care-activated",
      "shopcare-care-credit",
      "shopcare-care-offer",
      "shopcare-quote-declined",
      "shopcare-quote-expired",
      "shopcare-quote-paid",
      "shopcare-repair-status",
      "shopcare-trade-in-status",
    ]);
  });

  it.each(flowEvents)("%s sends exactly the declared fields", (event) => {
    const def = EVENTS[event];
    const declared = declaredFields(triggerToml(def.flowHandle!));
    const fields = (def.fields as (d: unknown) => Record<string, unknown>)(
      samples[event],
    );

    expect(declared.handle).toBe(def.flowHandle);
    expect(Object.keys(fields).sort()).toEqual([...declared.keys].sort());
    // Staff alerts carry no customer reference; customer triggers always do.
    expect(declared.customerReference).toBe(!def.staffAlert);
    // number_decimal fields are numbers; everything else is a string.
    for (const [key, value] of Object.entries(fields)) {
      expect(typeof value, key).toBe(
        declared.types[key] === "number_decimal" ? "number" : "string",
      );
    }
  });

  it("every event has a Klaviyo metric exactly when it has a Flow trigger", () => {
    for (const event of Object.keys(EVENTS) as EventName[]) {
      expect(Boolean(EVENTS[event].klaviyoMetric), event).toBe(
        Boolean(EVENTS[event].flowHandle),
      );
    }
  });

  it("formats the repair status like Rails", () => {
    expect(
      EVENTS.repair_status_changed.fields(samples.repair_status_changed).Status,
    ).toBe("In repair");
    expect(
      EVENTS.repair_status_changed.fields({
        ...samples.repair_status_changed,
        status: "ready",
      }).Status,
    ).toBe("Ready");
  });
});

describe("FlowClient", () => {
  it("sends flowTriggerReceive with the handle and payload", async () => {
    const fake = new FakeGraphql({
      flowTriggerReceive: { flowTriggerReceive: { userErrors: [] } },
    });
    await new FlowClient(fake).trigger("shopcare-care-offer", {
      customerId: "77",
      fields: { "Product title": "Boot", "Care price": 15.0 },
    });

    expect(fake.calls[0].query).toContain(
      "flowTriggerReceive(handle: $handle, payload: $payload)",
    );
    expect(fake.calls[0].variables).toEqual({
      handle: "shopcare-care-offer",
      payload: { customer_id: 77, "Product title": "Boot", "Care price": 15.0 },
    });
  });

  it("raises user errors and top-level errors as DeliveryError", async () => {
    const userErrors = new FakeGraphql({
      flowTriggerReceive: {
        flowTriggerReceive: {
          userErrors: [
            { field: "x", message: "Bad" },
            { field: "y", message: "Worse" },
          ],
        },
      },
    });
    await expect(
      new FlowClient(userErrors).trigger("h", {
        customerId: null,
        fields: {},
      }),
    ).rejects.toThrow(new DeliveryError("Bad, Worse"));

    const throttled = async () =>
      new Response(JSON.stringify({ errors: [{ message: "Throttled" }] }), {
        status: 200,
      });
    await expect(
      new FlowClient({ graphql: throttled }).trigger("h", { customerId: null, fields: {} }),
    ).rejects.toThrow("Throttled");

    const down = async () => new Response("", { status: 503 });
    await expect(
      new FlowClient({ graphql: down }).trigger("h", { customerId: null, fields: {} }),
    ).rejects.toMatchObject({ retryable: true });
  });

  it("builds payloads with and without a customer", () => {
    expect(flowPayload(null, { a: "1" })).toEqual({ a: "1" });
    expect(flowPayload("", { a: "1" })).toEqual({ a: "1" });
    expect(flowPayload("5", { a: "1" })).toEqual({ customer_id: 5, a: "1" });
    expect(flowCustomerId("gid://shopify/Customer/123")).toBe(123);
    // Beyond a JS number's exact range: sent as digits, never rounded.
    expect(flowCustomerId("90071992547409930")).toBe("90071992547409930");
    expect(() => flowCustomerId("abc")).toThrow(InvalidFlowCustomerIdError);
  });

  it("an invalid customer id is a permanent DeliveryError", async () => {
    const fake = new FakeGraphql({});
    await expect(
      new FlowClient(fake).trigger("h", { customerId: "abc", fields: {} }),
    ).rejects.toMatchObject({ name: "DeliveryError", retryable: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("KlaviyoClient", () => {
  it("uses the Events API", () => {
    const { url, init } = new KlaviyoClient("pk_test").buildRequest({
      metric: "ShopCare Care Offer",
      email: "a@example.com",
      properties: { x: 1 },
      uniqueId: "u1",
      time: new Date("2026-10-16T12:00:00Z"),
    });
    const headers = init.headers as Record<string, string>;

    expect(url).toBe("https://a.klaviyo.com/api/events");
    expect(headers.Authorization).toBe("Klaviyo-API-Key pk_test");
    expect(headers.revision).toBe(KLAVIYO_REVISION);
    const body = JSON.parse(String(init.body));
    expect(body.data.attributes.metric.data.attributes.name).toBe(
      "ShopCare Care Offer",
    );
    expect(body.data.attributes.profile.data.attributes.email).toBe(
      "a@example.com",
    );
    expect(body.data.attributes).toMatchObject({
      unique_id: "u1",
      properties: { x: 1 },
      time: "2026-10-16T12:00:00.000Z",
    });
  });

  it("raises a DeliveryError on failure, retryable only for 429/5xx/network", async () => {
    const respond = (status: number) =>
      vi.fn(
        async () => new Response("nope", { status }),
      ) as unknown as typeof fetch;
    const track = (f: typeof fetch) =>
      new KlaviyoClient("pk", f).track({
        metric: "m",
        email: "e@x.y",
        properties: {},
        uniqueId: "u",
      });

    await expect(track(respond(202))).resolves.toBeUndefined();
    await expect(track(respond(400))).rejects.toMatchObject({
      message: "Klaviyo 400: nope",
      retryable: false,
    });
    await expect(track(respond(429))).rejects.toMatchObject({
      retryable: true,
    });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(track(offline)).rejects.toMatchObject({ retryable: true });
  });
});

describe("shopifyMarketingConsent", () => {
  const consentFor = (address: unknown) =>
    shopifyMarketingConsent(
      new FakeGraphql({
        "customer(id:": {
          customer:
            address === undefined ? null : { defaultEmailAddress: address },
        },
      }),
    );

  it("is true only for SUBSCRIBED, for the same address", async () => {
    const subscribed = consentFor({
      emailAddress: "A@example.com",
      marketingState: "SUBSCRIBED",
    });
    await expect(
      subscribed({ customerId: "77", email: "a@example.com" }),
    ).resolves.toBe(true);
    await expect(
      subscribed({ customerId: "77", email: "other@example.com" }),
    ).resolves.toBe(false);

    for (const state of [
      "NOT_SUBSCRIBED",
      "PENDING",
      "UNSUBSCRIBED",
      "INVALID",
    ]) {
      await expect(
        consentFor({ emailAddress: "a@example.com", marketingState: state })({
          customerId: "77",
          email: "a@example.com",
        }),
      ).resolves.toBe(false);
    }
    await expect(consentFor(undefined)({ customerId: "77" })).resolves.toBe(
      false,
    );
  });

  it("asks for the customer by GID and never for guests", async () => {
    const fake = new FakeGraphql({
      "customer(id:": {
        customer: { defaultEmailAddress: { marketingState: "SUBSCRIBED" } },
      },
    });
    const check = shopifyMarketingConsent(fake);

    await expect(
      check({ customerId: null, email: "g@example.com" }),
    ).resolves.toBe(false);
    expect(fake.calls).toHaveLength(0);

    await check({ customerId: "77" });
    expect(fake.calls[0].query).toBe(CUSTOMER_MARKETING_CONSENT_QUERY);
    expect(fake.calls[0].variables).toEqual({
      id: "gid://shopify/Customer/77",
    });
  });
});

describe("Repair status changed trigger: status values", () => {
  it("sends every ticket status humanised, the postage statuses included", () => {
    // REPAIR_TICKET_STATUSES (app/models/repair-ticket.server.ts; checked in its own test).
    const statuses: RepairStatus[] = [
      "new", "assessing", "quoted", "quote_declined", "awaiting_item", "received",
      "in_repair", "ready", "completed", "cancelled", "rejected",
    ];
    const values = statuses.map(
      (status) => EVENTS.repair_status_changed.fields({ ticketId: 1, status, productTitle: "Boot" }).Status,
    );
    expect(values).toEqual([
      "New", "Assessing", "Quoted", "Quote declined", "Awaiting item", "Received",
      "In repair", "Ready", "Completed", "Cancelled", "Rejected",
    ]);
    // The trigger's description lists them for merchants building workflows.
    const toml = readFileSync("extensions/shopcare-flow-repair-status/shopify.extension.toml", "utf8");
    for (const value of values) expect(toml).toContain(value);
  });
});
