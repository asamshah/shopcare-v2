/**
 * PrismaNotificationStore and the Shop-row settings loader against Postgres,
 * plus one emit → deliver round trip through them.
 */
import { describe, expect, it } from "vitest";
import prisma from "../../../app/db.server";
import { encrypt } from "../../../app/lib/encryption.server";
import {
  deliverNotification,
  emitNotification,
  type NotificationDeps,
} from "../../../app/services/notifications.server";
import { PrismaNotificationStore } from "../../../app/services/notifications/prisma-store.server";
import { loadNotificationSettings } from "../../../app/services/notifications/shop-settings.server";
import { createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";

const store = () => new PrismaNotificationStore(prisma);
const claimInput = (shopId: string) => ({
  shopId,
  event: "care_activated" as const,
  channel: "flow" as const,
  idempotencyKey: "care_activated:cover_7",
  payload: {
    recipient: { customerId: "77", email: "a@example.com" },
    data: { coverId: 7, carePlan: "Care Plus", productTitle: "Boot", coverEnds: "2027-10-16" },
  },
});

describe("PrismaNotificationStore", () => {
  it("claims once per (shop, channel, key); a repeat finds the same row", async () => {
    const shop = await createShop();
    const first = await store().claim(claimInput(shop.shopifyDomain));
    const again = await store().claim(claimInput(shop.shopifyDomain));

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.delivery.id).toBe(first.delivery.id);
    expect(first.delivery).toMatchObject({
      shopId: shop.shopifyDomain,
      status: "pending",
      attempts: 0,
      payload: claimInput(shop.shopifyDomain).payload,
    });
    expect(await prisma.notificationDelivery.count()).toBe(1);

    // Another channel or another shop is a separate delivery.
    await store().claim({ ...claimInput(shop.shopifyDomain), channel: "klaviyo" });
    const other = await createShop();
    await store().claim(claimInput(other.shopifyDomain));
    expect(await prisma.notificationDelivery.count()).toBe(3);
  });

  it("concurrent claims create one row", async () => {
    const shop = await createShop();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => store().claim(claimInput(shop.shopifyDomain))),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.delivery.id)).size).toBe(1);
  });

  it("records sent, skipped and failed attempts", async () => {
    const shop = await createShop();
    const s = store();
    const { delivery } = await s.claim(claimInput(shop.shopifyDomain));

    expect(await s.markFailed(delivery.id, "timeout", { final: false })).toEqual({ attempts: 1 });
    expect(await s.find(delivery.id)).toMatchObject({ status: "pending", attempts: 1, error: "timeout" });
    expect(await s.markFailed(delivery.id, "x".repeat(600), { final: true })).toEqual({ attempts: 2 });
    const failed = await s.find(delivery.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 2 });
    expect(failed!.error).toHaveLength(500);

    await s.markSent(delivery.id);
    expect(await s.find(delivery.id)).toMatchObject({ status: "sent", error: null });
    await s.markSkipped(delivery.id, "Turned off");
    expect(await s.find(delivery.id)).toMatchObject({ status: "skipped", error: "Turned off" });
  });

  it("finds nothing for unknown or malformed ids, and refuses an unknown shop", async () => {
    expect(await store().find("999")).toBeNull();
    expect(await store().find("abc")).toBeNull();
    await expect(store().claim(claimInput("nope.myshopify.com"))).rejects.toThrow(/No shop/);
  });
});

describe("loadNotificationSettings", () => {
  it("reads settings.notifications with defaults: Flow off, 7-day Care offer", async () => {
    const shop = await createShop({ shopifyDomain: "acme-boots.myshopify.com" });
    expect(await loadNotificationSettings(shop.shopifyDomain)).toEqual({
      shopId: "acme-boots.myshopify.com",
      flowEnabled: false,
      klaviyoApiKey: null,
      careOfferDelayDays: 7,
    });
  });

  it("maps the stored settings and decrypts the Klaviyo key", async () => {
    const shop = await createShop({
      settings: {
        shop_name: "Acme",
        contact_email: "hello@acme.example",
        notifications: { flow: true, care_offer_delay_days: "10" },
      },
      klaviyoApiKeyCiphertext: encrypt("pk_live", "Shop.klaviyoApiKey"),
    });
    expect(await loadNotificationSettings(shop.shopifyDomain)).toEqual({
      shopId: shop.shopifyDomain,
      flowEnabled: true,
      klaviyoApiKey: "pk_live",
      careOfferDelayDays: 10,
    });
  });

  it("is null for an unknown or uninstalled shop", async () => {
    expect(await loadNotificationSettings("nope.myshopify.com")).toBeNull();
    const gone = await createShop({ uninstalledAt: new Date() });
    expect(await loadNotificationSettings(gone.shopifyDomain)).toBeNull();
  });
});

describe("emit → deliver through Postgres", () => {
  it("fires the Flow trigger once, and a duplicate emit sends nothing more", async () => {
    const shop = await createShop({ settings: { notifications: { flow: true } } });
    const enqueued: string[] = [];
    const flow = new FakeGraphql({ flowTriggerReceive: { flowTriggerReceive: { userErrors: [] } } });
    const deps: NotificationDeps = {
      store: store(),
      loadSettings: (domain) => loadNotificationSettings(domain),
      adminClient: async () => flow,
      enqueue: async (_job, { deliveryId }) => {
        enqueued.push(deliveryId);
      },
    };
    const settings = (await loadNotificationSettings(shop.shopifyDomain))!;
    const input = claimInput(shop.shopifyDomain);
    const emitOnce = () =>
      emitNotification("care_activated", { settings, recipient: input.payload.recipient, data: input.payload.data }, deps);

    await emitOnce();
    await emitOnce();
    expect(enqueued).toHaveLength(1);

    await deliverNotification(enqueued[0], deps);
    await deliverNotification(enqueued[0], deps);
    expect(flow.calls).toHaveLength(1);
    const row = await prisma.notificationDelivery.findFirstOrThrow();
    expect(row).toMatchObject({ status: "sent", channel: "flow", idempotencyKey: "care_activated:cover_7" });
  });
});
