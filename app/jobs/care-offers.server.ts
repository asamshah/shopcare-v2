import prisma from "../db.server";
import { dueCareOffers } from "../services/care/care-offers.server";
import {
  emitNotification,
  getNotificationDeps,
  type NotificationDeps,
} from "../services/notifications.server";
import { loadNotificationSettings } from "../services/notifications/shop-settings.server";

export interface CareOffersOptions {
  now?: Date;
  db?: typeof prisma;
  deps?: Pick<NotificationDeps, "store" | "enqueue">;
  /** The shop's currency; production asks Shopify (shop { currencyCode }). */
  currency?: (shopDomain: string) => Promise<string>;
}

async function shopifyCurrency(shopDomain: string): Promise<string> {
  const { adminClientForShop } = await import("../shopify/client.server");
  const { fetchShopInfo } = await import("../shopify/shop.server");
  return (await fetchShopInfo(await adminClientForShop(shopDomain)))
    .currencyCode;
}

/**
 * Emits every due "Add Care" offer for every installed shop (see
 * app/services/care/care-offers.server.ts). Each emit only claims deliveries
 * and enqueues them; consent is checked when the delivery is sent. A failing
 * shop doesn't stop the others; the job throws at the end so it's retried
 * (emits are idempotent).
 */
export async function emitCareOffers({
  now = new Date(),
  db = prisma,
  deps = getNotificationDeps(),
  currency = shopifyCurrency,
}: CareOffersOptions = {}): Promise<{ emitted: number; failed: string[] }> {
  const shops = await db.shop.findMany({ where: { uninstalledAt: null } });
  let emitted = 0;
  const failed: string[] = [];
  for (const shop of shops) {
    try {
      const settings = await loadNotificationSettings(shop.shopifyDomain, db);
      if (!settings) continue;
      const offers = await dueCareOffers(shop, {
        now,
        db,
        currency: () => currency(shop.shopifyDomain),
      });
      for (const offer of offers) {
        await emitNotification(
          "care_offer",
          { settings, recipient: offer.recipient, data: offer.data },
          deps,
        );
        emitted++;
      }
    } catch (error) {
      failed.push(shop.shopifyDomain);
      console.error(`[job:care-offers] ${shop.shopifyDomain}`, error);
    }
  }
  return { emitted, failed };
}

export async function careOffersJob(): Promise<void> {
  const { emitted, failed } = await emitCareOffers();
  console.info(`[job:care-offers] emitted ${emitted} offers`);
  if (failed.length)
    throw new Error(`care offers failed for ${failed.join(", ")}`);
}
