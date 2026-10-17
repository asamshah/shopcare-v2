/**
 * Shop lifecycle webhooks.
 *
 * `app/uninstalled` (markShopUninstalled): the shop row is kept but marked
 * `uninstalledAt` and its sessions deleted, so jobs and notifications stop
 * (loadNotificationSettings returns null for an uninstalled shop) while a
 * reinstall within Shopify's 48 hours keeps the merchant's data
 * (setUpShopAfterAuth clears `uninstalledAt`). Rails destroyed the shop
 * straight away; v2 leaves the erasure to shop/redact.
 *
 * `shop/redact` (redactShop, mandatory GDPR, ~48 h after uninstall): erases
 * the shop: its stored files (ticket photos, postage slips, registration
 * proofs, trade-in photos, GDPR exports), then the shop row, which cascades to every table,
 * its sessions and its saved jobs (`jobs` rows naming the shop, i.e. webhook
 * payloads; keyed by domain, so no cascade). Idempotent: a shop already gone
 * is a no-op.
 */
import prisma from "../../db.server";
import { getStorage, type FileStorage } from "../../lib/storage.server";
import { settingsOf } from "../../models/shop.server";
import { jsonArray } from "../../models/validation.server";

export async function markShopUninstalled(
  shopDomain: string,
  { db = prisma, now = new Date() }: { db?: typeof prisma; now?: Date } = {},
): Promise<void> {
  await db.shop.updateMany({
    where: { shopifyDomain: shopDomain, uninstalledAt: null },
    data: { uninstalledAt: now },
  });
  await db.session.deleteMany({ where: { shop: shopDomain } });
}

export async function storedFileKeys(shopId: number, db = prisma): Promise<string[]> {
  const keys: string[] = [];
  const images = await db.ticketImage.findMany({
    where: { repairTicket: { shopId }, storageKey: { not: null } },
    select: { storageKey: true },
  });
  keys.push(...images.map((image) => image.storageKey!));
  const slips = await db.repairTicket.findMany({
    where: { shopId, postageSlipKey: { not: null } },
    select: { postageSlipKey: true },
  });
  keys.push(...slips.map((ticket) => ticket.postageSlipKey!));
  const proofs = await db.registration.findMany({
    where: { shopId, proofKey: { not: null } },
    select: { proofKey: true },
  });
  keys.push(...proofs.map((proof) => proof.proofKey!));
  const tradeIns = await db.tradeIn.findMany({ where: { shopId }, select: { photos: true } });
  for (const tradeIn of tradeIns) {
    for (const photo of jsonArray(tradeIn.photos)) {
      const key = (photo as { key?: unknown })?.key;
      if (typeof key === "string" && key) keys.push(key);
    }
  }
  return keys;
}

export async function redactShop(
  shopDomain: string,
  {
    db = prisma,
    storage = getStorage(),
    logger = console,
  }: { db?: typeof prisma; storage?: FileStorage; logger?: Pick<Console, "warn" | "info"> } = {},
): Promise<{ deleted: boolean; files: number }> {
  await db.session.deleteMany({ where: { shop: shopDomain } });
  await db.job.deleteMany({ where: { shopDomain } });
  const shop = await db.shop.findUnique({ where: { shopifyDomain: shopDomain } });
  if (!shop) return { deleted: false, files: 0 };

  const keys = await storedFileKeys(shop.id, db);
  const exports = settingsOf(shop).gdpr_exports;
  if (Array.isArray(exports)) {
    for (const entry of exports) {
      const key = (entry as { key?: unknown })?.key;
      if (typeof key === "string") keys.push(key);
    }
  }
  let files = 0;
  for (const key of keys) {
    try {
      await storage.delete(key);
      files++;
    } catch (error) {
      logger.warn(`[gdpr/shop-redact] couldn't delete ${key}: ${String(error)}`);
    }
  }
  await db.shop.delete({ where: { id: shop.id } });
  logger.info(`[gdpr/shop-redact] erased ${shopDomain} (${files} files)`);
  return { deleted: true, files };
}
