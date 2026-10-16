import prisma from "../db.server";
import { dueCareOffers } from "../services/care/care-offers.server";
import {
  emitNotification,
  getNotificationDeps,
  type NotificationDeps,
} from "../services/notifications.server";
import { loadNotificationSettings } from "../services/notifications/shop-settings.server";
import { syncCareOfferTags } from "../services/care/care-offer-tags.server";
import { activeCarePlans } from "../models/care-plan.server";
import type { AdminGraphqlClient } from "../shopify/graphql.server";

export interface CareOffersOptions {
  now?: Date;
  db?: typeof prisma;
  deps?: Pick<NotificationDeps, "store" | "enqueue">;
  /** The shop's currency; production asks Shopify (shop { currencyCode }). */
  currency?: (shopDomain: string) => Promise<string>;
  /**
   * The Admin client used to keep the `shopcare-care-offer-eligible` customer
   * tag in step (production: the shop's offline session); false skips it.
   */
  tagClient?: ((shopDomain: string) => Promise<AdminGraphqlClient>) | false;
}

async function offlineClient(shopDomain: string): Promise<AdminGraphqlClient> {
  const { adminClientForShop } = await import("../shopify/client.server");
  return adminClientForShop(shopDomain);
}

async function shopifyCurrency(shopDomain: string): Promise<string> {
  const { adminClientForShop } = await import("../shopify/client.server");
  const { fetchShopInfo } = await import("../shopify/shop.server");
  return (await fetchShopInfo(await adminClientForShop(shopDomain)))
    .currencyCode;
}

/**
 * For every installed shop: emits every due "Add Care" offer to the optional
 * Flow / Klaviyo integrations (app/services/care/care-offers.server.ts; each
 * emit only claims deliveries and enqueues them), and keeps the
 * `shopcare-care-offer-eligible` customer tag in step for shops with Care
 * plans (care-offer-tags.server.ts), so merchants can email the offer from
 * Shopify Email without Flow. A failing shop doesn't stop the others; the job
 * throws at the end so it's retried (both steps are idempotent).
 */
export async function emitCareOffers({
  now = new Date(),
  db = prisma,
  deps = getNotificationDeps(),
  currency = shopifyCurrency,
  tagClient = offlineClient,
}: CareOffersOptions = {}): Promise<{ emitted: number; tagged: number; untagged: number; failed: string[] }> {
  const shops = await db.shop.findMany({ where: { uninstalledAt: null } });
  let emitted = 0;
  let tagged = 0;
  let untagged = 0;
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
      if (tagClient && (await activeCarePlans(shop.id, db)).length > 0) {
        const sync = await syncCareOfferTags(shop, await tagClient(shop.shopifyDomain), { now, db });
        tagged += sync.added.length;
        untagged += sync.removed.length;
      }
    } catch (error) {
      failed.push(shop.shopifyDomain);
      console.error(`[job:care-offers] ${shop.shopifyDomain}`, error);
    }
  }
  return { emitted, tagged, untagged, failed };
}

export async function careOffersJob(): Promise<void> {
  const { emitted, tagged, untagged, failed } = await emitCareOffers();
  console.info(`[job:care-offers] emitted ${emitted} offers; tagged ${tagged}, untagged ${untagged} customers`);
  if (failed.length)
    throw new Error(`care offers failed for ${failed.join(", ")}`);
}
