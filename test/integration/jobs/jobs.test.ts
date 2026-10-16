/**
 * Background jobs: the order backfill (Rails AfterAuthenticateJob +
 * ImportOrdersJob, made cursor-paged), the notification sweep and the GDPR
 * export prune.
 */
import type { Shop } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "../../../app/db.server";
import { pruneGdprExports } from "../../../app/jobs/daily-prune.server";
import { importOrdersJob, setImportOrdersDeps } from "../../../app/jobs/import-orders.server";
import { sweepPendingNotifications } from "../../../app/jobs/notification-sweep.server";
import { MemoryStorage } from "../../../app/lib/storage.server";
import { setUpShopAfterAuth } from "../../../app/services/shops/after-auth.server";
import { createNotificationDeliveryFor, createShop } from "../../support/factories";
import { FakeGraphql } from "../../support/fake-graphql";
import { orderNode } from "../../support/orders";

const settingsOf = async (shop: Shop) =>
  (await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).settings as Record<string, Record<string, unknown>>;

describe("order backfill", () => {
  let shop: Shop;
  const enqueued: { name: string; payload: Record<string, unknown> }[] = [];
  const enqueue = vi.fn(async (name: "import-orders", payload: Record<string, unknown>) => {
    enqueued.push({ name, payload });
  });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    enqueued.length = 0;
    shop = await createShop({ shopifyDomain: "after-auth.myshopify.com" });
  });
  afterEach(() => setImportOrdersDeps({}));

  const signingKeyApi = (fail = false) =>
    new FakeGraphql({
      currentAppInstallation: fail
        ? () => {
            throw new Error("boom");
          }
        : { currentAppInstallation: { id: "gid://shopify/AppInstallation/9" } },
      metafieldsSet: { metafieldsSet: { metafields: [], userErrors: [] } },
    });

  it("after authenticate sets up the signing key and queues the backfill only once", async () => {
    const api = signingKeyApi();
    await setUpShopAfterAuth(shop.shopifyDomain, api, prisma, enqueue);
    await setUpShopAfterAuth(shop.shopifyDomain, api, prisma, enqueue);
    expect(enqueued).toEqual([{ name: "import-orders", payload: { shopId: shop.id } }]);
    expect((await settingsOf(shop)).items_import.status).toBe("queued");
    expect(api.calls.some((c) => c.query.includes("currentAppInstallation"))).toBe(true);
  });

  it("a signing key failure doesn't stop the backfill", async () => {
    await setUpShopAfterAuth(shop.shopifyDomain, signingKeyApi(true), prisma, enqueue);
    expect(enqueued).toHaveLength(1);
  });

  it("the import job records its outcome, one page per run, re-enqueueing with the cursor", async () => {
    let page = 0;
    const api = new FakeGraphql({
      "orders(": () => {
        page++;
        return {
          orders: {
            nodes: [orderNode(page === 1 ? 701 : 702)],
            pageInfo: { hasNextPage: page === 1, endCursor: page === 1 ? "c1" : null },
          },
        };
      },
    });
    setImportOrdersDeps({ client: async () => api, enqueue, pagesPerRun: 1 });

    await importOrdersJob({ shopId: shop.id });
    expect(enqueued).toEqual([{ name: "import-orders", payload: { shopId: shop.id, cursor: "c1" } }]);
    expect((await settingsOf(shop)).items_import).toMatchObject({ status: "running", created: 1, cursor: "c1" });

    await importOrdersJob({ shopId: shop.id, cursor: "c1" });
    expect(api.calls[1].variables.after).toBe("c1");
    expect((await settingsOf(shop)).items_import).toMatchObject({ status: "finished", created: 2 });
    expect(await prisma.item.count({ where: { shopId: shop.id } })).toBe(2);

    // A retried page records nothing twice.
    await importOrdersJob({ shopId: shop.id, cursor: "c1" });
    expect(await prisma.item.count({ where: { shopId: shop.id } })).toBe(2);
  });

  it("a failing import is marked failed and rethrown for a retry", async () => {
    const api = new FakeGraphql({
      "orders(": () => {
        throw new Error("Shopify down");
      },
    });
    setImportOrdersDeps({ client: async () => api, enqueue });
    await expect(importOrdersJob({ shopId: shop.id })).rejects.toThrow("Shopify down");
    expect((await settingsOf(shop)).items_import.status).toBe("failed");
  });
});

describe("notification sweep", () => {
  it("re-enqueues deliveries stuck in pending, not fresh or old ones", async () => {
    const shop = await createShop();
    const now = new Date();
    const stuck = await createNotificationDeliveryFor(shop, { idempotencyKey: "a" });
    const fresh = await createNotificationDeliveryFor(shop, { idempotencyKey: "b" });
    const sent = await createNotificationDeliveryFor(shop, { idempotencyKey: "c", status: "sent" });
    await prisma.$executeRaw`UPDATE notification_deliveries SET updated_at = now() - interval '1 hour' WHERE id IN (${stuck.id}, ${sent.id})`;
    const ancient = await createNotificationDeliveryFor(shop, { idempotencyKey: "d" });
    await prisma.$executeRaw`UPDATE notification_deliveries SET created_at = now() - interval '5 days', updated_at = now() - interval '5 days' WHERE id = ${ancient.id}`;

    const enqueue = vi.fn(async () => {});
    expect(await sweepPendingNotifications({ now, enqueue })).toBe(1);
    expect(enqueue).toHaveBeenCalledWith("notification", { deliveryId: String(stuck.id) });
    expect(fresh.id).toBeDefined();
  });
});

describe("GDPR export prune", () => {
  it("deletes exports past retention, keeping recent ones", async () => {
    const storage = new MemoryStorage();
    const now = new Date();
    const old = new Date(now.getTime() - 40 * 86_400_000).toISOString();
    const shop = await createShop({
      settings: {
        gdpr_exports: [
          { key: "gdpr-exports/x/1.json", created_at: old },
          { key: "gdpr-exports/x/2.json", created_at: now.toISOString() },
        ],
      },
    });
    await storage.put("gdpr-exports/x/1.json", "{}");
    await storage.put("gdpr-exports/x/2.json", "{}");

    expect(await pruneGdprExports(now, prisma, storage)).toBe(1);
    expect(await storage.get("gdpr-exports/x/1.json")).toBeNull();
    expect(await storage.get("gdpr-exports/x/2.json")).not.toBeNull();
    const settings = (await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).settings as { gdpr_exports: { key: string }[] };
    expect(settings.gdpr_exports.map((e) => e.key)).toEqual(["gdpr-exports/x/2.json"]);
  });
});
