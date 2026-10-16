/**
 * Builders for notification tests: shop settings and sample data for every
 * email, plus a NotificationDeps bundle with in-memory fakes.
 */
import { vi } from "vitest";
import {
  LogEmailAdapter,
  setEmailAdapter,
} from "../../app/services/email.server";
import type { NotificationDeps } from "../../app/services/notifications.server";
import type { ShopNotificationSettings } from "../../app/services/notifications/settings.server";
import { InMemoryNotificationStore } from "../../app/services/notifications/store.server";
import type { EmailData } from "../../app/services/notifications/templates.server";
import { FakeGraphql } from "./fake-graphql";

export function buildSettings(
  overrides: Partial<ShopNotificationSettings> = {},
): ShopNotificationSettings {
  return {
    shopId: "acme.myshopify.com",
    shopName: "Acme Boots",
    logoUrl: "https://cdn.example.com/acme-logo.png",
    accentColor: "#bd4a27",
    addressLines: ["1 Cobbler Lane", "Northampton NN1 1AA", "United Kingdom"],
    storeUrl: "https://acme.example",
    supportEmail: "help@acme.example",
    staffEmail: "workshop@acme.example",
    locale: "en-GB",
    flowEnabled: false,
    klaviyoApiKey: null,
    ...overrides,
  };
}

const quote = {
  quotationId: 9,
  ticketId: 42,
  productTitle: "Chelsea Boot",
  customerName: "Sarah Jones",
  customerEmail: "sarah@example.com",
  quoteTotal: "£45.00",
  adminUrl: "https://admin.shopify.com/store/acme/apps/shopcare/tickets/42",
};

export const sampleEmailData: EmailData = {
  repair_received: {
    ticketId: 42,
    productTitle: "Chelsea Boot",
    customerName: "Sarah Jones",
    customerEmail: "sarah@example.com",
    description: "Heel worn down\nLeft boot only",
    statusUrl: "https://acme.example/apps/repairs/tickets/42",
    adminUrl: "https://admin.shopify.com/store/acme/apps/shopcare/tickets/42",
  },
  repair_status_changed: {
    ticketId: 42,
    status: "ready",
    productTitle: "Chelsea Boot",
    customerName: "Sarah Jones",
    statusUrl: "https://acme.example/apps/repairs/tickets/42",
  },
  send_item: {
    ticketId: 42,
    productTitle: "Chelsea Boot",
    customerName: "Sarah Jones",
    workshopAddress: ["Acme Repairs", "4 Cobbler's Yard", "Northampton NN1 1AA", "United Kingdom"],
    instructions: "Pack your item securely and use a tracked service. Put the packing slip inside the parcel.",
    downloadUrl: "https://acme.myshopify.com/apps/repairs/tickets/42/postage-slip?expires=1793000000&token=abc",
    sendNumber: 1,
  },
  item_received: {
    ticketId: 42,
    productTitle: "Chelsea Boot",
    customerName: "Sarah Jones",
    statusUrl: "https://acme.example/apps/repairs/tickets/42",
  },
  care_welcome: {
    coverId: 7,
    carePlan: "Care Plus",
    productTitle: "Chelsea Boot",
    coverEnds: "2027-10-16",
    customerName: "Sarah Jones",
  },
  care_credit_issued: {
    coverId: 7,
    carePlan: "Care Plus",
    productTitle: "Chelsea Boot",
    creditCode: "CARE-7XK2",
    creditAmount: 15,
    currency: "GBP",
    creditExpires: "2027-01-14",
    customerName: "Sarah Jones",
    storeUrl: "https://acme.example",
  },
  care_offer: {
    orderId: 1001,
    productTitle: "Chelsea Boot",
    carePlan: "Care Plus",
    carePrice: 15,
    currency: "GBP",
    offerEnds: "2026-11-15",
    addCareUrl: "https://acme.example/pages/add-care",
    customerName: "Sarah Jones",
  },
  staff_repair_request: {
    ticketId: 42,
    productTitle: "Chelsea Boot",
    customerName: "Sarah Jones",
    customerEmail: "sarah@example.com",
    description: "Heel worn down",
    adminUrl: "https://admin.shopify.com/store/acme/apps/shopcare/tickets/42",
  },
  staff_quote_paid: { ...quote, orderName: "#1001" },
  staff_quote_declined: { ...quote, reason: "Too expensive" },
  staff_quote_expired: { ...quote, validUntil: "2026-10-30" },
};

export function buildDeps(overrides: Partial<NotificationDeps> = {}) {
  const store = new InMemoryNotificationStore();
  const email = new LogEmailAdapter(true);
  setEmailAdapter(email);
  const graphql = new FakeGraphql({
    flowTriggerReceive: { flowTriggerReceive: { userErrors: [] } },
  });
  const settings = { current: buildSettings() };
  const enqueued: string[] = [];
  const deps = {
    store,
    loadSettings: vi.fn(async () => settings.current),
    hasEmailMarketingConsent: vi.fn(async () => true),
    adminClient: vi.fn(async () => graphql),
    unsubscribeUrl: vi.fn(
      () => "https://shopcare.test/unsubscribe?token=abc",
    ) as NotificationDeps["unsubscribeUrl"],
    enqueue: vi.fn(async (_job: "notification", { deliveryId }) => {
      enqueued.push(deliveryId);
    }),
    fetch: vi.fn(
      async () => new Response("", { status: 202 }),
    ) as unknown as typeof fetch,
    ...overrides,
  } satisfies NotificationDeps;
  return { deps, store, email, graphql, settings, enqueued };
}
